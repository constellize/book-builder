#!/usr/bin/env node

/**
 * Emoji / non-ASCII character validation for book content.
 *
 * WHAT THIS GATE IS FOR
 * ---------------------
 * The PDF targets render through xelatex with a fixed font stack. Pictographic
 * emoji (U+1F300+, plus things like the Dingbats check marks) have no glyph in
 * that stack, so they silently drop out of the PDF or render as tofu. That is
 * what this gate exists to catch.
 *
 * WHAT THIS GATE IS *NOT* FOR
 * ---------------------------
 * Box-drawing characters (U+2500-257F) and arrows (U+2190-21FF) are legitimate
 * typography. The book uses 86 box-drawing characters to draw directory trees in
 * ch5.md and 24 "->" arrows in prose across introduction.md, ch7-ch9.md. Those
 * are intentional, they have glyphs, and they must NOT fail the build. They are
 * reported in an informational section so a reviewer can see them, and that is
 * all.
 *
 * PREVIOUS COVERAGE HOLES (fixed here)
 * ------------------------------------
 *  (a) introduction.md was not in the file pattern list, so all 24 arrows plus
 *      anything else in the longest front-matter file were never scanned at all.
 *      Coverage is now asserted against the build-included file list, so a file
 *      that pandoc reads can no longer be silently skipped.
 *  (b) The detection ranges covered neither box-drawing nor arrows, so those
 *      characters were invisible. They are now detected and classified as
 *      typography rather than being ignored.
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

// ---------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------
//
// Two categories:
//   'emoji'      -> pictographic; fails the build unless explicitly approved.
//   'typography' -> line art / arrows; reported for visibility, never fails.
//
// Ranges are [lo, hi] inclusive code points.

const CHARACTER_CLASSES = [
  // ---- typography: legitimate, glyph-backed, never a build failure ----
  { name: 'Arrows',                    category: 'typography', ranges: [[0x2190, 0x21FF]] },
  { name: 'Box Drawing',               category: 'typography', ranges: [[0x2500, 0x257F]] },
  { name: 'Block Elements',            category: 'typography', ranges: [[0x2580, 0x259F]] },
  { name: 'Geometric Shapes',          category: 'typography', ranges: [[0x25A0, 0x25FF]] },
  { name: 'Supplemental Arrows-A',     category: 'typography', ranges: [[0x27F0, 0x27FF]] },
  { name: 'Supplemental Arrows-B',     category: 'typography', ranges: [[0x2900, 0x297F]] },

  // ---- emoji: pictographic, no glyph in the PDF font stack ----
  { name: 'Emoticons',                 category: 'emoji', ranges: [[0x1F600, 0x1F64F]] },
  { name: 'Misc Symbols & Pictographs',category: 'emoji', ranges: [[0x1F300, 0x1F5FF]] },
  { name: 'Transport & Map Symbols',   category: 'emoji', ranges: [[0x1F680, 0x1F6FF]] },
  { name: 'Supplemental Pictographs',  category: 'emoji', ranges: [[0x1F900, 0x1F9FF]] },
  { name: 'Pictographs Extended-A',    category: 'emoji', ranges: [[0x1FA70, 0x1FAFF]] },
  { name: 'Enclosed / Playing Cards',  category: 'emoji', ranges: [[0x1F004, 0x1F0CF], [0x1F170, 0x1F251]] },
  { name: 'Regional Indicators',       category: 'emoji', ranges: [[0x1F1E6, 0x1F1FF]] },
  { name: 'Fitzpatrick Modifiers',     category: 'emoji', ranges: [[0x1F3FB, 0x1F3FF]] },
  { name: 'Misc Symbols',              category: 'emoji', ranges: [[0x2600, 0x26FF]] },
  { name: 'Dingbats',                  category: 'emoji', ranges: [[0x2700, 0x27BF]] },
  { name: 'Misc Symbols & Arrows',     category: 'emoji', ranges: [[0x2B00, 0x2BFF]] },
  { name: 'CJK Enclosed Emoji',        category: 'emoji', ranges: [[0x3030, 0x3030], [0x303D, 0x303D], [0x3297, 0x3297], [0x3299, 0x3299]] },
  { name: 'Zero Width Joiner',         category: 'emoji', ranges: [[0x200D, 0x200D]] },
  { name: 'Variation Selector-16',     category: 'emoji', ranges: [[0xFE0F, 0xFE0F]] }
];

/**
 * Classify a code point. Returns { name, category } or null for ordinary text.
 * Typography classes are tested first so that any future overlap resolves in
 * favour of "this is legitimate typography", never in favour of failing a build
 * on a line-drawing character.
 */
function classifyCodePoint(codePoint) {
  for (const cls of CHARACTER_CLASSES) {
    for (const [lo, hi] of cls.ranges) {
      if (codePoint >= lo && codePoint <= hi) {
        return cls;
      }
    }
  }
  return null;
}

// Approved emojis that are safe for PDF rendering.
// NOTE: strip-emojis.js imports this Set; keep it exported as a Set of strings.
const approvedEmojis = new Set([
  '✓', // Check mark
  '✔', // Heavy check mark
  '✅', // White heavy check mark
  '❌', // Cross mark
  '⚠', // Warning sign
  '⚡', // High voltage
  '⭐', // White medium star
  '\u{1F50D}', // Magnifying glass
  '\u{1F4DD}', // Memo
  '\u{1F680}', // Rocket
  '️'  // Variation Selector-16 (invisible emoji-presentation selector)
]);

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

// Files pandoc actually assembles into the book, per book-builder/config/book.config.js
// (source.foreword, source.introduction, source.chapters, source.appendices).
// source.references is generated into build/intermediate/ and is not read from disk.
// These MUST all be scanned; coverage is asserted below.
const buildIncludedGlobs = [
  'foreword-faq.md',
  'introduction.md',
  'ch[1-9].md',
  'app[AB].md'
];

// Additional non-shipped files worth linting (README, tone guide, generated
// prompt-reference partials). Not coverage-critical.
const bookContentPatterns = [
  /^ch\d+.*\.md$/,        // Chapter files (ch1.md, ch2.md, ...)
  /^introduction\.md$/,   // Introduction  <-- was missing; held all 24 arrows
  /^app[A-Z].*\.md$/,     // Appendix files (appA.md, appB.md, ...)
  /^foreword.*\.md$/,     // Foreword files
  /^README\.md$/,         // Main README
  /^tone\.md$/            // Tone guide
];

// Patterns to exclude (narrative and development files)
const excludePatterns = [
  /^codepromptu\//,
  /^narrative-/,
  /^memory-bank\//,
  /^marketing\//,
  /^tools\//,
  /^build\//,
  /^\.git/,
  /^node_modules\//,
  /example-chapter\.md$/,
  /ch1-revised\.md$/,
  /ch4a\.md$/,
  /README-teaser\.md$/
];

function shouldProcessFile(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);

  // CRITICAL: Explicitly exclude node_modules and other dependency directories
  if (relativePath.includes('node_modules') ||
      relativePath.includes('/node_modules/') ||
      relativePath.startsWith('node_modules/') ||
      relativePath.includes('book-builder/node_modules') ||
      relativePath.includes('book-backup/') ||
      relativePath.includes('.git/')) {
    return false;
  }

  for (const pattern of excludePatterns) {
    if (pattern.test(relativePath)) {
      return false;
    }
  }

  const fileName = path.basename(relativePath);
  for (const pattern of bookContentPatterns) {
    if (pattern.test(fileName)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Walk the text one code point at a time (NOT one UTF-16 unit at a time, so
 * astral-plane emoji are handled correctly) and record every classified
 * character with its position.
 */
function findClassifiedCharacters(text) {
  const found = [];
  let index = 0;   // UTF-16 index, for line/column reporting
  let line = 1;
  let column = 1;

  for (const ch of text) {
    if (ch === '\n') {
      line += 1;
      column = 1;
      index += 1;
      continue;
    }

    const cls = classifyCodePoint(ch.codePointAt(0));
    if (cls) {
      found.push({ char: ch, line, column, index, class: cls });
    }

    index += ch.length;
    column += 1;
  }

  return found;
}

function unicodeLabel(ch) {
  return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

// Characters with no visible glyph: print the code point, not the character.
function displayChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x200D || cp === 0xFE0F) return `<${unicodeLabel(ch)}>`;
  return `"${ch}"`;
}

function validateEmojis() {
  console.log('Validating emoji usage in book content files...\n');

  const markdownFiles = glob.sync('**/*.md', {
    ignore: [
      '**/node_modules/**',
      'node_modules/**',
      '**/book-builder/node_modules/**',
      '**/book-backup/**',
      'book-backup/**',
      '**/build/**',
      'build/**',
      '**/.git/**',
      '.git/**',
      '**/dist/**',
      'dist/**'
    ]
  });

  const bookFiles = markdownFiles.filter(shouldProcessFile);

  // --- Coverage assertion: every file pandoc reads must be in the scan set ---
  const buildIncludedFiles = [];
  for (const pattern of buildIncludedGlobs) {
    buildIncludedFiles.push(...glob.sync(pattern));
  }
  const scanned = new Set(bookFiles);
  const uncovered = buildIncludedFiles.filter((f) => !scanned.has(f));

  console.log(`Build-included source files: ${buildIncludedFiles.length}`);
  console.log(`Total files in scan set:     ${bookFiles.length}\n`);

  let hasErrors = false;

  if (uncovered.length > 0) {
    hasErrors = true;
    console.log('COVERAGE GAP: these files are assembled into the book but are not scanned:');
    for (const f of uncovered) {
      console.log(`  - ${f}`);
    }
    console.log('  Fix bookContentPatterns in validate-emojis.js.\n');
  }

  const violations = [];
  const typographyByChar = new Map(); // "U+2192 →" -> { char, class, count, files:Set }

  for (const filePath of bookFiles) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      console.error(`ERROR reading ${filePath}: ${error.message}`);
      hasErrors = true;
      continue;
    }

    const hits = findClassifiedCharacters(content);
    if (hits.length === 0) {
      console.log(`OK   ${filePath} - no emoji or special characters`);
      continue;
    }

    const fileViolations = [];
    const fileApproved = [];
    const fileTypography = new Map();

    for (const hit of hits) {
      if (hit.class.category === 'typography') {
        const key = `${unicodeLabel(hit.char)} ${hit.char}`;
        fileTypography.set(key, (fileTypography.get(key) || 0) + 1);

        if (!typographyByChar.has(key)) {
          typographyByChar.set(key, { char: hit.char, class: hit.class, count: 0, files: new Set() });
        }
        const agg = typographyByChar.get(key);
        agg.count += 1;
        agg.files.add(filePath);
        continue;
      }

      // category === 'emoji'
      if (approvedEmojis.has(hit.char)) {
        fileApproved.push(hit);
      } else {
        const violation = {
          file: filePath,
          emoji: hit.char,
          line: hit.line,
          column: hit.column,
          unicode: unicodeLabel(hit.char),
          block: hit.class.name
        };
        fileViolations.push(violation);
        violations.push(violation);
        hasErrors = true;
      }
    }

    console.log(`\nChecking ${filePath}:`);

    for (const v of fileViolations) {
      console.log(`  FAIL Line ${v.line}, Column ${v.column}: ${displayChar(v.emoji)} (${v.unicode}, ${v.block}) - NOT APPROVED`);
    }
    for (const a of fileApproved) {
      console.log(`  ok   Line ${a.line}, Column ${a.column}: ${displayChar(a.char)} (${unicodeLabel(a.char)}) - approved emoji`);
    }
    for (const [key, count] of fileTypography) {
      console.log(`  info ${key} x${count} - typography (not emoji, allowed)`);
    }
    if (fileViolations.length === 0) {
      console.log(`  -> no unapproved emoji`);
    }
  }

  // --- Informational typography report ---
  console.log('\n\n--- Typography characters found (informational, not failures) ---\n');
  if (typographyByChar.size === 0) {
    console.log('None.');
  } else {
    let typographyTotal = 0;
    const rows = [...typographyByChar.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [key, agg] of rows) {
      typographyTotal += agg.count;
      console.log(`  ${key.padEnd(10)} x${String(agg.count).padStart(3)}  ${agg.class.name.padEnd(24)} ${[...agg.files].join(', ')}`);
    }
    console.log(`\n  Total typography characters: ${typographyTotal}`);
    console.log('  These are box-drawing / arrow glyphs. They render correctly in all');
    console.log('  targets and are intentional. They do not fail this gate.');
  }

  console.log('\n\n--- Validation Summary ---\n');
  console.log(`   Files checked:              ${bookFiles.length}`);
  console.log(`   Build-included files:       ${buildIncludedFiles.length}`);
  console.log(`   Coverage gaps:              ${uncovered.length}`);
  console.log(`   Unapproved emoji found:     ${violations.length}`);
  console.log(`   Typography chars found:     ${[...typographyByChar.values()].reduce((n, a) => n + a.count, 0)}`);

  if (hasErrors) {
    console.log('\nEMOJI VALIDATION FAILED\n');

    if (violations.length > 0) {
      console.log('Unapproved emojis detected in book content files:');
      for (const v of violations) {
        console.log(`  ${v.file}:${v.line}:${v.column} - ${displayChar(v.emoji)} (${v.unicode}, ${v.block})`);
      }

      console.log('\nTo fix these issues:');
      console.log('1. Run the emoji stripping tool: node book-builder/scripts/strip-emojis.js');
      console.log('2. Manually remove specific emojis from the files listed above');
      console.log('3. Replace with approved alternatives if needed');
      console.log('4. Or add the emoji to approvedEmojis in book-builder/scripts/validate-emojis.js');
      console.log('\nApproved emojis:', Array.from(approvedEmojis).map(displayChar).join(' '));
    }

    process.exit(1);
  } else {
    console.log('\nEMOJI VALIDATION PASSED');
    console.log('All emojis in book content files are approved for PDF rendering,');
    console.log('and every build-included source file was scanned.');
  }
}

// Run validation if called directly
if (require.main === module) {
  validateEmojis();
}

module.exports = {
  validateEmojis,
  approvedEmojis,
  CHARACTER_CLASSES,
  classifyCodePoint,
  findClassifiedCharacters
};
