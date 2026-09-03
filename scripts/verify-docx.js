#!/usr/bin/env node

/**
 * verify-docx.js — acceptance checks for a built .docx.
 *
 *     node book-builder/scripts/verify-docx.js build/docx-digital/constellize-book.docx
 *     node book-builder/scripts/verify-docx.js build/docx-print/constellize-book.docx --render
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT EXISTS
 * ---------------------------------------------------------------------------
 * EVERY failure mode on the docx path is silent and exits 0. Not "most" — every
 * one that has actually happened here:
 *
 *   - the docx writer DROPS raw LaTeX without a diagnostic, so the `\appendix`
 *     block that switches the LaTeX counter to A/B does nothing and the
 *     appendices render as "10 Appendix A" / "11 Appendix B";
 *   - it renders raw HTML as nothing, so a callout filter aimed at the wrong
 *     writer produces a document with 156 callouts silently missing;
 *   - `--reference-doc` pointing at a stale file gives Calibri body text and a
 *     document that opens perfectly;
 *   - skipping scripts/lib/docx-postprocess.js loses per-chapter open-right
 *     breaks and Atkinson list markers, changing nothing that a file listing,
 *     a byte count or a "did pandoc exit 0" check can see;
 *   - `{SITE_BASE}` left unsubstituted turns 67 prompt hyperlinks into literal
 *     placeholder text that still typesets neatly.
 *
 * So the build cannot be trusted to have worked because it succeeded. Every
 * number below was measured against a known-good document and is asserted
 * exactly, not as a lower bound, unless the comment says otherwise.
 *
 * Exit codes:  0 all checks pass   1 one or more checks failed   2 bad usage
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const config = require('../config/book.config.js');

// ---------------------------------------------------------------------------
// Expected values
// ---------------------------------------------------------------------------

/**
 * Callout divs in the manuscript, and therefore callout tables in the docx.
 *
 * Measured from source: 35 info + 31 code + 14 conversation + 5 warning
 * + 2 success + 1 error + 67 promptref = 156, matching the 156 closing `:::`
 * fences. If a callout is added to the book this number moves with it — that is
 * the point of asserting it exactly rather than "> 100".
 */
const EXPECTED_CALLOUTS = 156;

/**
 * Genuine markdown tables in the manuscript: ch7.md ("Factor | Favors Separate
 * | Favors Integrated") and ch8.md ("Dimension | Key Metrics | What to Track").
 *
 * They are matched by their header text rather than counted, because the whole
 * point of the table check is to separate them from the callout tables and a
 * bare count could not tell which was which. Everything that is a `<w:tbl>` and
 * is NOT one of these two is a callout.
 */
const CONTENT_TABLE_MARKERS = ['Favors Separate', 'Key Metrics'];

/**
 * `::: {.promptref title="..." url="..."}` blocks. Each contributes one prompt
 * name shown as the callout title and one external hyperlink to the prompt.
 */
const EXPECTED_PROMPTS = 67;

/**
 * Distinct external hyperlink relationships in word/_rels/document.xml.rels.
 *
 * A LOWER BOUND, deliberately. Baseline before promptref recovery was 13 (the
 * arxiv / github / vendor links in the prose); restoring the prompt links takes
 * it to ~80 (67 prompt URLs + 17 distinct prose URLs = 84 as measured). The
 * floor catches the failure that matters — the prompt links vanishing again —
 * without breaking every time somebody cites one more URL.
 */
const MIN_EXTERNAL_LINKS = 80;

/**
 * Files under word/media/: 9 chapter images + 2 appendix images + the inline
 * diagrams. Exact, because a dropped image is otherwise invisible: pandoc warns
 * on a missing image file and carries on.
 */
const EXPECTED_MEDIA = 70;

/**
 * Font parts under word/fonts/. 4 Atkinson Hyperlegible Next faces + 4 Atkinson
 * Hyperlegible Mono faces, obfuscated as .odttf. Word silently substitutes when
 * an embedded face is missing, so a document with 6 of 8 looks fine on the
 * machine that has the fonts installed and wrong everywhere else.
 */
const EXPECTED_FONT_PARTS = 8;

/**
 * Top-level headings that must NOT carry a section number: the front matter,
 * the bibliography and both appendices. Chapters 1-9 must carry one.
 *
 * Numbers come from a `<w:rStyle w:val="SectionNumber"/>` run that pandoc writes
 * as literal text — there is no Word outline numbering to inspect, so this is
 * the only place the numbering is visible.
 */
const UNNUMBERED_HEADINGS = [
  'Foreword',
  'Introduction',
  'References',
  'Appendix A:',
  'Appendix B:',
];

/** Chapters that must carry a section number, in order. */
const EXPECTED_CHAPTER_NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Paragraph style whose every occurrence opens a new odd-page section. */
const CHAPTER_STYLE = 'Heading1';

/**
 * Per-engine timeout for the opt-in `--render` check, seconds.
 *
 * docx-to-pdf.js defaults to 180, which is sized for the reference document.
 * The book is 200-odd pages with 70 embedded images and a TOC that Word rebuilds
 * twice, and it does not finish in 180s. Override with --render-timeout.
 */
const RENDER_TIMEOUT_SECONDS = 900;

/**
 * The one style that differs between the two reference documents, and therefore
 * the only way to tell from the output which one pandoc actually used.
 *
 * Everything else about reference-digital.docx and reference-print.docx is
 * shared (see config/docx-styles.js: "WHAT ACTUALLY DIFFERS BETWEEN THE TWO
 * VARIANTS: THE HYPERLINK STYLE. THAT IS THE WHOLE LIST."). Swapping the two
 * `referenceDoc` paths in book.config.js would therefore produce two documents
 * that are correct in every visible respect except that the print manuscript
 * spends ink on blue underlined URLs - which is exactly the kind of thing that
 * reaches a typesetter unnoticed.
 */
const HYPERLINK_STYLE = {
  digital: { color: '0000FF', underline: 'single' },
  print: { color: 'auto', underline: 'none' },
};

// ---------------------------------------------------------------------------
// tiny XML helpers
//
// Regex, not a DOM parser, for the same reason docx-postprocess.js uses regex:
// the checks are about literal element/attribute presence in a file pandoc
// wrote, and a round trip through a parser would normalise away exactly the
// details being asserted (attribute order, self-closing spelling, whitespace).
// ---------------------------------------------------------------------------

/** Decode the five XML predefined entities. */
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Normalise text for comparison against the markdown sources.
 *
 * pandoc's `smart` extension (on for every target, see the `from:` line in the
 * defaults files) rewrites ' " -- --- ... into typographic forms, so a prompt
 * title in the docx is not byte-identical to the same title in the .md. Fold
 * both sides onto ASCII and collapse whitespace before comparing.
 */
function normalizeText(s) {
  return s
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** All `<w:t>` text of an OOXML fragment, concatenated and unescaped. */
function textOf(xml) {
  const out = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(unescapeXml(m[1]));
  return out.join('');
}

/**
 * Every `<w:p>` element in document order.
 *
 * `(?:(?!<\/w:p>)[\s\S])*?` rather than `[\s\S]*?` so a paragraph can never
 * swallow the one after it. `<w:p\b(?:\s[^>]*)?>` matches both `<w:p>` and
 * `<w:p w:rsidR="...">` while never matching `<w:pPr>` or `<w:pStyle>`.
 */
function paragraphs(xml) {
  const re = /<w:p\b(?:\s[^>]*)?>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push({ xml: m[0], start: m.index, end: re.lastIndex });
  return out;
}

/**
 * Top-level `<w:tbl>` elements, with the nesting depth tracked.
 *
 * Depth matters: a conversation callout nests one table per speaker turn inside
 * the callout's own table, and counting those as separate callouts would put the
 * total well past 156. Only depth-0 tables are returned.
 *
 * `unbalanced` is reported rather than swallowed. The docx callout filter emits
 * each box as an UNBALANCED pair of raw-OpenXML fragments (an opener, the div's
 * blocks, a closer), so a filter bug leaves a `<w:tbl>` that never closes - and
 * Word's response to that is to "repair" the document on open, i.e. silently
 * rewrite it.
 *
 * @returns {{tables: string[], unbalanced: number}}
 */
function tables(xml) {
  const out = [];
  let depth = 0;
  let start = -1;
  let stray = 0;
  const re = /<w:tbl(?:\s[^>]*)?>|<\/w:tbl\s*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[0][1] !== '/') {
      if (depth === 0) start = m.index;
      depth++;
    } else if (depth === 0) {
      stray++; // a closer with no opener
    } else {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(xml.slice(start, re.lastIndex));
        start = -1;
      }
    }
  }
  return { tables: out, unbalanced: stray + depth };
}

/** Does this paragraph carry `<w:pStyle w:val="name"/>`? Tolerates ` />`. */
function hasStyle(paraXml, name) {
  return new RegExp(`<w:pStyle w:val="${name}"\\s*/>`).test(paraXml);
}

// ---------------------------------------------------------------------------
// result collection
// ---------------------------------------------------------------------------

class Report {
  constructor() {
    this.rows = [];
  }

  /**
   * @param {boolean} ok
   * @param {string} name
   * @param {string} detail what was actually measured - printed pass OR fail,
   *   so a passing run is evidence and not just a row of ticks
   */
  add(ok, name, detail) {
    this.rows.push({ ok, name, detail });
    return ok;
  }

  get failed() {
    return this.rows.filter((r) => !r.ok);
  }

  print() {
    const width = Math.max(...this.rows.map((r) => r.name.length));
    for (const r of this.rows) {
      const mark = r.ok ? 'PASS' : 'FAIL';
      console.log(`  ${mark}  ${r.name.padEnd(width)}  ${r.detail}`);
    }
  }
}

// ---------------------------------------------------------------------------
// package access
// ---------------------------------------------------------------------------

/**
 * Unzip the .docx into a temp dir and return a small accessor over it.
 * `unzip` rather than a zip library, matching docx-postprocess.js, so the two
 * agree byte for byte about what is in the package.
 */
function openDocx(docxPath) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docxverify-'));
  try {
    execFileSync('unzip', ['-q', path.resolve(docxPath), '-d', work], { stdio: 'pipe' });
  } catch (err) {
    // A .docx is a zip. Anything that will not unzip is not one - most often a
    // half-written file from an interrupted build, or the wrong path. Report it
    // as such instead of letting an unhandled execFileSync error print a stack
    // trace and (through a pipe) look like a clean exit.
    fs.rmSync(work, { recursive: true, force: true });
    console.error(
      `verify-docx: ${path.resolve(docxPath)} is not a readable zip archive, so it ` +
        `cannot be a .docx.\n  unzip: ${String(err.stderr || err.message).trim()}`
    );
    process.exit(1);
  }
  return {
    dir: work,
    has: (rel) => fs.existsSync(path.join(work, rel)),
    read: (rel) => fs.readFileSync(path.join(work, rel), 'utf8'),
    list: (rel) => (fs.existsSync(path.join(work, rel)) ? fs.readdirSync(path.join(work, rel)) : []),
    close: () => fs.rmSync(work, { recursive: true, force: true }),
  };
}

/**
 * Prompt titles declared in the manuscript, read from the SOURCE markdown.
 *
 * Read from source rather than hard-coded so the check tests the pipeline
 * (title attribute -> callout filter -> docx text) rather than testing a list
 * against itself. A source file that cannot be read is a hard failure: a
 * fallback here would quietly reduce this to "the count looked plausible".
 */
function promptTitlesFromSources() {
  const root = config.source.root;
  const names = [];
  if (config.source.foreword) names.push(config.source.foreword);
  if (config.source.introduction) names.push(config.source.introduction);
  for (let i = 1; i <= 9; i++) names.push(`ch${i}.md`);
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) names.push(`app${letter}.md`);

  const titles = [];
  for (const name of names) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const re = /^:::+\s*\{[^}\n]*\.promptref\b[^}\n]*\}/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
      const t = /\btitle="([^"]*)"/.exec(m[0]);
      titles.push({ file: name, title: t ? t[1] : null });
    }
  }
  return titles;
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

function checkPackage(pkg, report) {
  const required = [
    'word/document.xml',
    'word/numbering.xml',
    'word/styles.xml',
    'word/_rels/document.xml.rels',
  ];
  const missing = required.filter((r) => !pkg.has(r));
  report.add(
    missing.length === 0,
    'package parts',
    missing.length === 0 ? `all ${required.length} required parts present` : `missing ${missing.join(', ')}`
  );
}

function checkFonts(pkg, report) {
  const parts = pkg.list('word/fonts').filter((f) => f.endsWith('.odttf'));
  report.add(
    parts.length === EXPECTED_FONT_PARTS,
    'embedded font parts',
    `${parts.length} (expected ${EXPECTED_FONT_PARTS}): ${parts.sort().join(' ')}`
  );

  // The parts are dead weight unless fontTable.xml.rels points at them: Word
  // reads the relationships, not the directory listing.
  const rels = pkg.has('word/_rels/fontTable.xml.rels')
    ? pkg.read('word/_rels/fontTable.xml.rels')
    : '';
  const refs = (rels.match(/Target="fonts\/font\d+\.odttf"/g) || []).length;
  report.add(
    refs === EXPECTED_FONT_PARTS,
    'font relationships',
    `${refs} fontTable.xml.rels entries (expected ${EXPECTED_FONT_PARTS})`
  );
}

/**
 * Confirm the document was built from the reference doc its target names.
 *
 * @param {'digital'|'print'|null} variant expected variant, or null if unknown
 */
function checkVariant(pkg, variant, report) {
  if (!variant) {
    report.add(
      false,
      'reference doc variant',
      'could not tell which variant this should be from the path; pass --variant digital|print'
    );
    return;
  }

  const styles = pkg.read('word/styles.xml');
  const style = /<w:style\b[^>]*w:styleId="Hyperlink"[^>]*>([\s\S]*?)<\/w:style>/.exec(styles);
  if (!style) {
    report.add(false, 'reference doc variant', 'word/styles.xml declares no Hyperlink style');
    return;
  }

  const color = /<w:color w:val="([^"]*)"/.exec(style[1]);
  const underline = /<w:u w:val="([^"]*)"/.exec(style[1]);
  const got = { color: color && color[1], underline: underline && underline[1] };
  const want = HYPERLINK_STYLE[variant];
  const ok = got.color === want.color && got.underline === want.underline;

  // Name the variant the document actually looks like, not just "wrong": the
  // likely cause is the two referenceDoc paths being swapped, and saying so
  // turns a puzzle into a one-line fix.
  const looksLike =
    Object.keys(HYPERLINK_STYLE).find(
      (v) => HYPERLINK_STYLE[v].color === got.color && HYPERLINK_STYLE[v].underline === got.underline
    ) || 'neither variant';

  report.add(
    ok,
    'reference doc variant',
    ok
      ? `${variant}: Hyperlink is color=${got.color} underline=${got.underline}`
      : `expected ${variant} (color=${want.color} underline=${want.underline}) but got ` +
        `color=${got.color} underline=${got.underline}, which is ${looksLike} - ` +
        `check referenceDoc on outputs["docx-${variant}"] in book-builder/config/book.config.js`
  );
}

function checkMedia(pkg, report) {
  const media = pkg.list('word/media');
  report.add(
    media.length === EXPECTED_MEDIA,
    'embedded media',
    `${media.length} files in word/media (expected ${EXPECTED_MEDIA})`
  );
}

function checkExternalLinks(pkg, report) {
  const rels = pkg.read('word/_rels/document.xml.rels');
  const targets = [];
  // `\/?>` so a non-self-closing `<Relationship ...></Relationship>` is still
  // matched. pandoc writes the self-closing form, but a relationship that is
  // present and unseen would understate the link count rather than fail loudly.
  const re = /<Relationship\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(rels)) !== null) {
    const attrs = m[1];
    if (!/TargetMode="External"/.test(attrs)) continue;
    const t = /\bTarget="([^"]*)"/.exec(attrs);
    if (t) targets.push(unescapeXml(t[1]));
  }

  report.add(
    targets.length >= MIN_EXTERNAL_LINKS,
    'external hyperlinks',
    `${targets.length} external relationships (need >= ${MIN_EXTERNAL_LINKS})`
  );

  const prompts = targets.filter((t) => /\/prompts\//.test(t));
  report.add(
    prompts.length === EXPECTED_PROMPTS,
    'prompt hyperlinks',
    `${prompts.length} targets under /prompts/ (expected ${EXPECTED_PROMPTS})`
  );

  // {SITE_BASE} / {CODEPROMPTU_REPO_BASE} surviving into the output means
  // processRepositoryLinks() did not run for this target - which happens when
  // the outputs entry omits siteBaseUrl. The links still typeset.
  const placeholders = targets.filter((t) => /\{[A-Z_]+\}/.test(t));
  report.add(
    placeholders.length === 0,
    'link placeholders',
    placeholders.length === 0
      ? 'no unsubstituted {SITE_BASE}/{CODEPROMPTU_REPO_BASE} in link targets'
      : `${placeholders.length} unsubstituted: ${placeholders.slice(0, 3).join(', ')}`
  );
}

function checkTables(doc, report) {
  const { tables: all, unbalanced } = tables(doc);

  report.add(
    unbalanced === 0,
    'table nesting',
    unbalanced === 0
      ? `${all.length} top-level <w:tbl>, all balanced`
      : `${unbalanced} unbalanced <w:tbl> - Word will "repair" (silently rewrite) this file`
  );

  const content = all.filter((t) => {
    const txt = normalizeText(textOf(t));
    return CONTENT_TABLE_MARKERS.some((marker) => txt.includes(marker));
  });
  const callouts = all.length - content.length;

  report.add(
    content.length === CONTENT_TABLE_MARKERS.length,
    'content tables',
    `${content.length} manuscript tables matched by header text (expected ${CONTENT_TABLE_MARKERS.length})`
  );
  report.add(
    callouts === EXPECTED_CALLOUTS,
    'callout tables',
    `${callouts} of ${all.length} top-level tables are callouts (expected ${EXPECTED_CALLOUTS})`
  );
}

function checkPromptTitles(doc, report) {
  const declared = promptTitlesFromSources();
  const untitled = declared.filter((d) => !d.title);
  report.add(
    declared.length === EXPECTED_PROMPTS && untitled.length === 0,
    'promptref sources',
    `${declared.length} .promptref divs in the manuscript, ${untitled.length} without a title= ` +
      `(expected ${EXPECTED_PROMPTS} / 0)`
  );

  const body = normalizeText(textOf(doc));
  const missing = declared
    .filter((d) => d.title && !body.includes(normalizeText(d.title)))
    .map((d) => `${d.file}: "${d.title}"`);

  report.add(
    missing.length === 0 && declared.length === EXPECTED_PROMPTS,
    'prompt titles in docx',
    missing.length === 0
      ? `all ${declared.length} prompt names present as text (expected ${EXPECTED_PROMPTS})`
      : `${missing.length} missing, e.g. ${missing.slice(0, 3).join('; ')}`
  );
}

/**
 * Commands that must never reach the docx, with why each one is here.
 *
 * Verified against the manuscript: `\vspace` (ch4.md) is the ONLY one of these
 * that appears in any source file, so none of them can be a false positive from
 * a code sample.
 */
const FORBIDDEN_LATEX = [
  // Spliced before the first appendix H1 for the LaTeX targets. The docx writer
  // drops it, so the appendices keep the chapter counter: "10 Appendix A".
  // processSpecialSections() skips the splice for docx.
  '\\appendix',
  // ch4.md line 412, a bare \vspace{1em} spacing a figure in the PDFs. Stripped
  // by the docx raw-LaTeX stripper in processSpecialSections().
  '\\vspace',
  // metadata.yaml sets `date: \today` for the LaTeX targets. Blanked out by the
  // `metadata: date: ""` override in the docx defaults files; without it the
  // title page reads "\today".
  '\\today',
  // Page-breaking commands: silently dropped, so a document that relies on them
  // for layout would be wrong in a way nothing else here would notice.
  '\\newpage',
  '\\clearpage',
];

function checkNoRawLatex(doc, report) {
  const text = normalizeText(textOf(doc));

  // Two searches per command on purpose. The text search catches the case that
  // actually happens - the writer treating the command as a paragraph of prose.
  // The raw search catches it hiding in an attribute or a raw-openxml block
  // where it would not be `<w:t>` text.
  const hits = [];
  for (const cmd of FORBIDDEN_LATEX) {
    const re = new RegExp(cmd.replace(/\\/g, '\\\\'), 'g');
    const inText = (text.match(re) || []).length;
    const anywhere = (doc.match(re) || []).length;
    if (inText || anywhere) hits.push(`${cmd} (${inText} in text, ${anywhere} in xml)`);
  }

  report.add(
    hits.length === 0,
    'no raw LaTeX',
    hits.length === 0
      ? `none of ${FORBIDDEN_LATEX.join(' ')} present`
      : `found ${hits.join(', ')}`
  );
}

/**
 * Citations must be resolved, and the bibliography must be in the document.
 *
 * This is the failure the docx defaults files carry a warning about. Declaring
 * citeproc as a top-level `citeproc: true` key instead of an entry in an ordered
 * filter chain runs it outside the chain, and pandoc-crossref then reverts every
 * Cite element to literal "[@key]" text. It did exactly that to all 28 citations
 * in the digital PDF while STILL emitting a correct bibliography, so the page
 * count, the file size and the References section all looked untouched. Both
 * halves are therefore asserted: rendered citations AND a populated bibliography.
 */
function checkCitations(doc, report) {
  const text = normalizeText(textOf(doc));
  const raw = text.match(/\[@[A-Za-z0-9_:.\-]+/g) || [];
  report.add(
    raw.length === 0,
    'citations resolved',
    raw.length === 0
      ? 'no literal [@citekey] text'
      : `${raw.length} unresolved: ${[...new Set(raw)].slice(0, 5).join(', ')}`
  );

  const entries = (doc.match(/<w:pStyle w:val="Bibliography"\s*\/>/g) || []).length;
  report.add(entries > 0, 'bibliography', `${entries} Bibliography-styled paragraphs (expected > 0)`);
}

/**
 * Every Heading1 paragraph, in document order, with its text and numbering.
 *
 * `text` is everything the paragraph says; `title` is that with the section
 * number stripped. They differ because pandoc writes the number as a
 * SectionNumber-styled run followed by a `<w:tab/>` - and a tab is not `<w:t>`
 * text, so the concatenated string is "10Appendix A: ..." with nothing between
 * them. Matching "^Appendix" against `text` would therefore MISS exactly the
 * numbered appendix this script exists to catch.
 */
function chapterHeadings(doc) {
  return paragraphs(doc)
    .filter((p) => hasStyle(p.xml, CHAPTER_STYLE))
    .map((p) => {
      const numberRun = /<w:rStyle w:val="SectionNumber"\s*\/>[\s\S]*?<w:t\b[^>]*>([\s\S]*?)<\/w:t>/.exec(
        p.xml
      );
      const number = numberRun ? unescapeXml(numberRun[1]).trim() : null;
      const text = normalizeText(textOf(p.xml));
      return {
        ...p,
        number,
        text,
        title: number && text.startsWith(number) ? text.slice(number.length).trim() : text,
      };
    });
}

function checkHeadingNumbering(headings, report) {
  const numbered = headings.filter((h) => h.number !== null);
  const unnumbered = headings.filter((h) => h.number === null);

  report.add(
    headings.length === EXPECTED_CHAPTER_NUMBERS.length + UNNUMBERED_HEADINGS.length,
    'top-level headings',
    `${headings.length} ${CHAPTER_STYLE} paragraphs (expected ` +
      `${EXPECTED_CHAPTER_NUMBERS.length + UNNUMBERED_HEADINGS.length})`
  );

  const gotNumbers = numbered.map((h) => h.number);
  report.add(
    gotNumbers.join(',') === EXPECTED_CHAPTER_NUMBERS.join(','),
    'chapter numbering',
    `numbered headings: [${gotNumbers.join(', ')}] (expected [${EXPECTED_CHAPTER_NUMBERS.join(', ')}])`
  );

  // The one this whole target-aware \appendix business is about. With the raw
  // LaTeX still in place the docx writer drops it and these two continue the
  // chapter counter: "10 Appendix A", "11 Appendix B".
  const appendices = headings.filter((h) => /^Appendix [A-G]:/.test(h.title));
  const numberedAppendices = appendices.filter((h) => h.number !== null);
  report.add(
    appendices.length === 2 && numberedAppendices.length === 0,
    'appendices unnumbered',
    `${appendices.length} appendix headings, ${numberedAppendices.length} carry a section number ` +
      `(expected 2 / 0)` +
      (numberedAppendices.length
        ? `: rendered as ${numberedAppendices.map((h) => `"${h.number} ${h.title}"`).join('; ')}`
        : '')
  );

  const unexpectedNumbering = unnumbered
    .map((h) => h.title)
    .filter((t) => !UNNUMBERED_HEADINGS.some((u) => t.startsWith(u)));
  report.add(
    unexpectedNumbering.length === 0,
    'front/back matter',
    unexpectedNumbering.length === 0
      ? `unnumbered: ${unnumbered.map((h) => h.title.slice(0, 24)).join(', ')}`
      : `unexpected unnumbered headings: ${unexpectedNumbering.join(', ')}`
  );
}

/**
 * Every chapter heading must open an odd-page section.
 *
 * Structural, not rendered: a `<w:sectPr>` carrying `<w:type w:val="oddPage"/>`
 * inside the pPr of the paragraph immediately before the heading. That break
 * paragraph is inserted by docx-postprocess.js BEFORE the heading's
 * `<w:bookmarkStart/>`, so bookmarks are skipped when walking backwards - see
 * rewindOverBookmarks() there for why the anchor has to stay with its heading.
 *
 * A heading that is the first block of the body legitimately has no break: the
 * body-level sectPr covers it, and that sectPr must itself be oddPage.
 */
function checkOddPageSections(doc, headings, report) {
  const bodyOpen = /<w:body\b[^>]*>/.exec(doc);
  const bodyStart = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;

  const bad = [];
  let firstInBody = 0;

  for (const h of headings) {
    const before = doc.slice(bodyStart, h.start);
    if (before.trim() === '') {
      firstInBody++;
      continue;
    }
    // Walk back over whitespace and bookmarkStart elements to the paragraph
    // that should carry the break.
    let tail = before.replace(/(?:\s*<w:bookmarkStart\b[^>]*\/>)*\s*$/, '');
    const lastPara = /<w:p\b(?:\s[^>]*)?>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>\s*$/.exec(tail);
    const ok =
      lastPara !== null &&
      /<w:sectPr\b[\s\S]*?<w:type w:val="oddPage"\s*\/>[\s\S]*?<\/w:sectPr>/.test(lastPara[0]);
    if (!ok) bad.push(h.title.slice(0, 40));
  }

  const bodySectPr = /<w:sectPr\b(?:(?!<\/w:sectPr>)[\s\S])*?<\/w:sectPr>\s*<\/w:body>/.exec(doc);
  const bodyOddPage = bodySectPr !== null && /<w:type w:val="oddPage"\s*\/>/.test(bodySectPr[0]);

  report.add(
    bad.length === 0,
    'open-right chapters',
    bad.length === 0
      ? `${headings.length - firstInBody} of ${headings.length} headings preceded by an ` +
        `oddPage section break` +
        (firstInBody ? `, ${firstInBody} first in body (covered by the body sectPr)` : '')
      : `${bad.length} heading(s) with no oddPage break: ${bad.join('; ')}`
  );

  report.add(
    bodyOddPage,
    'body section type',
    bodyOddPage
      ? 'body <w:sectPr> is oddPage'
      : 'body <w:sectPr> is NOT oddPage - the first chapter can land on a verso'
  );
}

// ---------------------------------------------------------------------------
// optional render check
// ---------------------------------------------------------------------------

/**
 * Render to PDF and confirm every chapter heading really lands on an odd page.
 *
 * Opt-in (`--render`) because it needs Word or LibreOffice and takes minutes.
 * The structural check above is the one that runs in CI; this is the one that
 * proves the structural check is asking the right question.
 *
 * Engine defaults to `word`: LibreOffice drops the implicit blank verso an
 * oddPage break needs, so it renders open-right books four pages short with
 * chapters on versos while the logical page numbers stay correct - a wrong
 * answer that looks right. See scripts/lib/docx-render.js.
 */
function checkRendered(docxPath, engine, headings, report, timeoutSeconds) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docxverify-pdf-'));
  try {
    renderAndCheck(docxPath, engine, headings, report, outDir, timeoutSeconds);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function renderAndCheck(docxPath, engine, headings, report, outDir, timeoutSeconds) {
  const script = path.resolve(__dirname, 'docx-to-pdf.js');
  let pdf;
  try {
    // docx-to-pdf.js defaults to a 180s per-engine timeout, which is sized for a
    // reference document, not for the book: Word has to update every field,
    // rebuild the TOC twice, repaginate ~200 pages and export 70 images. Measured
    // well past 180s on this manuscript, so the default here is deliberately
    // generous - a timeout would be reported as a conversion failure and read as
    // a real defect.
    execFileSync(
      'node',
      [
        script,
        path.resolve(docxPath),
        '--engine',
        engine,
        '--timeout',
        String(timeoutSeconds),
        '-o',
        outDir,
      ],
      { stdio: 'inherit' }
    );
    const produced = fs.readdirSync(outDir).filter((f) => f.endsWith('.pdf'));
    if (produced.length === 0) throw new Error('docx-to-pdf.js produced no PDF');
    pdf = path.join(outDir, produced[0]);
  } catch (err) {
    report.add(false, `render (${engine})`, `conversion failed: ${err.message}`);
    return;
  }

  let text;
  try {
    text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 64e6 });
  } catch (err) {
    report.add(false, `render (${engine})`, `pdftotext failed: ${err.message}`);
    return;
  }

  // pdftotext separates pages with \f, so index+1 is the physical page number.
  const pages = text.split('\f');

  // A page with ANY dot-leader line is the table of contents, which repeats
  // every heading verbatim. Measured on the Word render of this book: dot
  // leaders appear on pages 2-7 and on no other page at all, so one is a clean
  // discriminator. A threshold of three was NOT: the last TOC page carries only
  // two entries, so it stayed in the search set and its "Foreword" running head
  // captured the Foreword, reporting p7 for a heading that is on p9.
  const isToc = pages.map((p) => (p.match(/\.{4,}\s*\d+\s*$/gm) || []).length >= 1);

  // Locating a heading by "the first page whose text contains it ANYWHERE" does
  // not work, and passes for the wrong reason. Measured on this book: that rule
  // put chapter 7 on p25 and the References on p113, because the Introduction's
  // "The book is organized as follows" list names every chapter and chapter 6
  // cross-references chapter 7 by title. The page numbers it returned were still
  // all odd, so the check reported PASS while having located almost nothing.
  //
  // A chapter heading is instead the FIRST substantive text on its own page -
  // that is what an odd-page section break means - so only the head of the page
  // is searched, and the matches must come out in document order.
  //
  // The head is measured in CHARACTERS OF NORMALISED TEXT, not "the first line".
  // A long Heading1 wraps: "2 Knowledge Gathering via the" / "Constellize
  // Method" on p39, "Appendix A: Constellize Method" / "Summary" on p171. A
  // first-line rule misses both and then matches the running head on a later
  // page instead - it put chapter 2 on p41 and lost Appendix A entirely.
  // Normalising collapses the wrap, so 120 characters comfortably covers the
  // longest heading in the book while stopping well short of the body text.
  const HEAD_CHARS = 120;
  const bad = [];
  const missing = [];
  const located = [];
  let after = 0; // headings appear in document order; never match backwards

  for (const h of headings) {
    const needle = normalizeText(h.title).slice(0, 40);
    if (!needle) {
      missing.push('(empty heading)');
      continue;
    }

    let page = -1;
    for (let i = after; i < pages.length; i++) {
      if (isToc[i]) continue;
      if (normalizeText(pages[i]).slice(0, HEAD_CHARS).includes(needle)) {
        page = i;
        break;
      }
    }

    if (page === -1) {
      // NOT a skip. A heading that cannot be found at the top of any page after
      // the previous one is a finding in its own right: either the text did not
      // survive the conversion, or the heading did not start a page. Silently
      // passing over it would turn this whole check into "the headings I
      // happened to find were fine".
      missing.push(needle);
      continue;
    }

    after = page + 1;
    const physical = page + 1;
    located.push(`${needle.slice(0, 12)}=p${physical}`);
    if (physical % 2 === 0) bad.push(`"${needle}" on page ${physical}`);
  }

  const ok = bad.length === 0 && missing.length === 0 && located.length === headings.length;
  report.add(
    ok,
    `render (${engine})`,
    ok
      ? `${pages.length - 1} pages; all ${located.length} headings open an odd page ` +
        `[${located.join(', ')}]`
      : [
          bad.length ? `${bad.length} on an even page: ${bad.join('; ')}` : null,
          missing.length
            ? `${missing.length} not found at the top of a page, in order: ${missing.join('; ')}`
            : null,
        ]
          .filter(Boolean)
          .join(' | ')
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function usage(msg) {
  if (msg) console.error(`verify-docx: ${msg}\n`);
  console.error(
    'Usage: node book-builder/scripts/verify-docx.js <file.docx>\n' +
      '                                   [--variant digital|print]\n' +
      '                                   [--render[=word|libreoffice]]\n' +
      `                                   [--render-timeout <seconds>]\n` +
      '\n' +
      '  Acceptance checks for a built .docx. Structural by default; --render\n' +
      '  additionally converts to PDF and confirms chapter page parity.\n' +
      '\n' +
      '  --variant defaults to whichever of build/docx-digital / build/docx-print\n' +
      '  the file sits in.\n' +
      `  --render-timeout defaults to ${RENDER_TIMEOUT_SECONDS}s per engine.\n`
  );
  process.exit(2);
}

/**
 * Which reference-doc variant this file is supposed to be, from its directory.
 *
 * The build writes build/docx-digital/ and build/docx-print/, so the directory
 * name is the target name and the suffix is the variant. Returns null when the
 * path says nothing - checkVariant() then FAILS asking for --variant rather
 * than skipping, because "we could not tell" is not the same as "it is fine".
 */
function variantFromPath(docxPath) {
  const dir = path.basename(path.dirname(path.resolve(docxPath)));
  const m = /^docx-(digital|print)$/.exec(dir);
  return m ? m[1] : null;
}

function main(argv) {
  const args = argv.slice(2);
  let docxPath = null;
  let render = null;
  let variant = null;
  let renderTimeout = RENDER_TIMEOUT_SECONDS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--render') render = 'word';
    else if (arg.startsWith('--render=')) render = arg.slice('--render='.length);
    else if (arg === '--variant') variant = args[++i];
    else if (arg.startsWith('--variant=')) variant = arg.slice('--variant='.length);
    else if (arg === '--render-timeout') renderTimeout = Number(args[++i]);
    else if (arg.startsWith('--render-timeout='))
      renderTimeout = Number(arg.slice('--render-timeout='.length));
    else if (arg === '-h' || arg === '--help') usage();
    else if (arg.startsWith('-')) usage(`unknown option ${arg}`);
    else if (docxPath === null) docxPath = arg;
    else usage('more than one input file');
  }

  if (!docxPath) usage('no .docx given');
  if (!fs.existsSync(docxPath)) usage(`no such file: ${docxPath}`);
  if (render && render !== 'word' && render !== 'libreoffice') {
    usage(`--render takes "word" or "libreoffice", got "${render}"`);
  }
  if (variant && !HYPERLINK_STYLE[variant]) {
    usage(`--variant takes "digital" or "print", got "${variant}"`);
  }
  if (!Number.isFinite(renderTimeout) || renderTimeout <= 0) {
    usage('--render-timeout takes a positive number of seconds');
  }
  if (!variant) variant = variantFromPath(docxPath);

  console.log(`Verifying ${path.resolve(docxPath)}`);
  console.log(`  ${(fs.statSync(docxPath).size / 1024).toFixed(1)} KiB`);
  console.log('');

  const report = new Report();
  const pkg = openDocx(docxPath);
  let unreadable = false;
  try {
    checkPackage(pkg, report);
    // Bail out rather than have every later check fail with a confusing message
    // about a file that is simply not there. Set a flag instead of calling
    // process.exit() here - process.exit() skips the `finally` below and leaves
    // the unzipped temp directory behind.
    if (report.failed.length) {
      unreadable = true;
      return finish(report, unreadable);
    }

    const doc = pkg.read('word/document.xml');
    const headings = chapterHeadings(doc);

    checkTables(doc, report);
    checkExternalLinks(pkg, report);
    checkPromptTitles(doc, report);
    checkMedia(pkg, report);
    checkVariant(pkg, variant, report);
    checkCitations(doc, report);
    checkNoRawLatex(doc, report);
    checkHeadingNumbering(headings, report);
    checkFonts(pkg, report);
    checkOddPageSections(doc, headings, report);

    if (render) checkRendered(docxPath, render, headings, report, renderTimeout);
  } finally {
    pkg.close();
  }

  return finish(report, unreadable);
}

/** Print the report and set the exit code. */
function finish(report, unreadable) {
  report.print();
  console.log('');

  if (unreadable) {
    console.error('verify-docx: package is not a readable docx; remaining checks skipped.');
    process.exitCode = 1;
    return;
  }

  const failed = report.failed;
  if (failed.length) {
    console.error(`verify-docx: ${failed.length} of ${report.rows.length} checks FAILED`);
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
    return;
  }

  console.log(`verify-docx: all ${report.rows.length} checks passed`);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { main };
