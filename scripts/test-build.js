#!/usr/bin/env node

/**
 * Build-system smoke test (`npm test` inside book-builder/).
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 *  - Test 2 required ../../example-chapter.md, a file that no longer exists in the
 *    book repo, so the script exited 1 before reaching any real check. It could
 *    never pass.
 *  - Test 4 looked for templates/filters/callout-filter.lua. The real filters are
 *    callout-filter-digital.lua and callout-filter-print.lua, so it always printed
 *    a failure -- and then, because test 4 never called process.exit, the script
 *    finished by announcing "All tests passed!" anyway.
 *  - It wrote its scratch output into book-builder/test-output/ and left the
 *    directory behind.
 *
 * WHAT IT DOES NOW
 * ----------------
 * Runs a self-contained fixture through pandoc (no dependency on any book source
 * file), resolves the Lua filter list from book.config.js rather than hardcoding
 * names, exercises the callout filter for real, works in a temp dir, and reports
 * an accurate pass/fail.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const config = require('../config/book.config.js');

const failures = [];
const notes = [];

function ok(msg) { console.log(`   PASS ${msg}`); }
function fail(msg) { console.log(`   FAIL ${msg}`); failures.push(msg); }
function info(msg) { console.log(`   note ${msg}`); notes.push(msg); }

console.log('Testing book build system...\n');

// ---------------------------------------------------------------------------
// 1. Required tools
// ---------------------------------------------------------------------------
console.log('1. Checking required tools...');

// MacTeX installs into /Library/TeX/texbin via /etc/paths.d, which non-login
// shells (and some CI runners) do not pick up. Search there before declaring
// xelatex missing, so this test reports a genuinely absent TeX rather than an
// unexported PATH.
const EXTRA_BIN_DIRS = ['/Library/TeX/texbin', '/usr/local/texlive/bin', '/opt/homebrew/bin'];

function findTool(name) {
  try {
    execSync(`${name} --version`, { stdio: 'pipe' });
    return name;
  } catch (_) { /* fall through to explicit paths */ }

  for (const dir of EXTRA_BIN_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      try {
        execSync(`"${candidate}" --version`, { stdio: 'pipe' });
        return candidate;
      } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

const pandocBin = findTool('pandoc');
if (pandocBin) {
  ok(`pandoc is available (${pandocBin})`);
} else {
  fail('pandoc is not available - no target can build');
}

const xelatexBin = findTool('xelatex');
if (xelatexBin) {
  ok(`xelatex is available (${xelatexBin})`);
  if (xelatexBin !== 'xelatex') {
    info(`xelatex was not on PATH; found at ${xelatexBin}. Add its directory to PATH for the PDF targets.`);
  }
} else {
  fail('xelatex is not available - the digital and print PDF targets cannot build');
}

// Without pandoc nothing further is meaningful.
if (!pandocBin) {
  console.log('\nBUILD SYSTEM TEST FAILED');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Lua filters declared by the config actually exist
// ---------------------------------------------------------------------------
console.log('\n2. Checking Lua filters declared in book.config.js...');

const rootDir = config.source.root;

// config.pandoc.filters maps target -> array of entries. An entry is either a
// path string or { anyOf: [path, ...] } (first existing wins).
function resolveFilterEntry(entry) {
  const candidates = typeof entry === 'string' ? [entry] : (entry.anyOf || []);
  const existing = candidates.filter((c) => fs.existsSync(path.resolve(rootDir, c)));
  return { candidates, existing };
}

const filterTargets = (config.pandoc && config.pandoc.filters) || {};
const seenFilters = new Set();

for (const [target, entries] of Object.entries(filterTargets)) {
  for (const entry of entries) {
    const { candidates, existing } = resolveFilterEntry(entry);
    const key = candidates.join('|');
    if (seenFilters.has(key)) continue;
    seenFilters.add(key);

    if (existing.length > 0) {
      ok(`${existing[0]} (used by: ${target})`);
    } else {
      fail(`no filter found for [${candidates.join(', ')}] declared by target "${target}"`);
    }
  }
}
if (seenFilters.size === 0) {
  info('config declares no Lua filters outside the pandoc defaults files');
}

// ---------------------------------------------------------------------------
// 3. End-to-end pandoc conversion on a self-contained fixture
// ---------------------------------------------------------------------------
console.log('\n3. Testing pandoc conversion on a fixture...');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-builder-test-'));
const fixturePath = path.join(tmpDir, 'fixture.md');
const outputPath = path.join(tmpDir, 'fixture.html');

// Exercises the two constructs the book relies on: a fenced-div callout and a
// promptref with attributes.
fs.writeFileSync(fixturePath, [
  '# Fixture Chapter',
  '',
  'Body text with an arrow -> and a `code span`.',
  '',
  '::: info',
  'A callout body.',
  ':::',
  '',
  '::: {.promptref title="Fixture Prompt" url="https://example.invalid/p"}',
  'Prompt reference body.',
  ':::',
  ''
].join('\n'), 'utf8');

try {
  execSync(`"${pandocBin}" "${fixturePath}" -o "${outputPath}"`, { stdio: 'pipe' });
  if (fs.existsSync(outputPath) && fs.readFileSync(outputPath, 'utf8').includes('Fixture Chapter')) {
    ok('basic markdown -> HTML conversion works');
  } else {
    fail('pandoc produced no usable HTML output');
  }
} catch (error) {
  fail(`pandoc conversion failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// 4. The callout filter actually runs
// ---------------------------------------------------------------------------
console.log('\n4. Testing the HTML callout filter end to end...');

const htmlFilterEntries = (filterTargets.web || []).map(resolveFilterEntry).filter((r) => r.existing.length > 0);

if (htmlFilterEntries.length === 0) {
  info('no resolvable HTML filters to exercise');
} else {
  const filterArgs = htmlFilterEntries
    .map((r) => `--lua-filter="${path.resolve(rootDir, r.existing[0])}"`)
    .join(' ');
  const filteredOut = path.join(tmpDir, 'fixture-filtered.html');
  try {
    execSync(`"${pandocBin}" "${fixturePath}" ${filterArgs} -o "${filteredOut}"`, { stdio: 'pipe' });
    if (fs.existsSync(filteredOut)) {
      ok(`filters ran without error (${htmlFilterEntries.length} filter(s))`);
    } else {
      fail('filtered pandoc run produced no output');
    }
  } catch (error) {
    fail(`filtered pandoc run failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.log('BUILD SYSTEM TEST FAILED');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

console.log('BUILD SYSTEM TEST PASSED - build system is ready.');
if (notes.length > 0) {
  console.log('\nNotes:');
  for (const n of notes) console.log(`  - ${n}`);
}
console.log('\nNext steps:');
console.log('- Run `npm run build:digital` to build the digital PDF');
console.log('- Run `npm run build:web` to build the web version');
console.log('- Run `npm run build:all` to build every target');
