#!/usr/bin/env node

/**
 * PDF conformance checks (`make pdf-verify`).
 *
 * WHY THIS EXISTS
 * ---------------
 * The print PDF shipped for a month declaring `PDF/X-1a:2003` conformance -- output intent,
 * XMP, "Level A, Accessible" -- while containing no CMYK at all. Nothing caught it: the
 * build exits 0 and `book-validate` is clean, because neither looks at colour space. See
 * buildSystemDefects.md R8.
 *
 * The expensive failure mode is not "non-conformant". It is "claims conformance it does not
 * have", because that is precisely what makes a printer trust the file and skip their own
 * checks. So every check here compares a CLAIM against the CONTENT, and a mismatch is an
 * error rather than a warning.
 *
 * Deliberately depends only on poppler (pdfinfo/pdffonts/pdfimages), already required by the
 * docx pipeline, plus a byte scan of the file itself.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', DIM = '\x1b[90m', RST = '\x1b[0m';

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return e.stdout || '';
  }
}

function countOccurrences(buf, needle) {
  const n = Buffer.from(needle, 'latin1');
  let c = 0, i = 0;
  while ((i = buf.indexOf(n, i)) !== -1) { c++; i += n.length; }
  return c;
}

function checkPdf(file, { expectPrint }) {
  const findings = [];
  const add = (sev, rule, msg, detail) => findings.push({ sev, rule, msg, detail });

  if (!fs.existsSync(file)) {
    add('error', 'missing', `${file} does not exist — build it first`);
    return findings;
  }

  const buf = fs.readFileSync(file);
  const info = run('pdfinfo', [file]);
  const fonts = run('pdffonts', [file]);

  const get = (k) => (info.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [, ''])[1].trim();

  // --- claim vs content: the check that would have caught R8 --------------
  const subtype = get('PDF subtype');
  const claimsX = /PDF\/X/.test(subtype) || countOccurrences(buf, 'GTS_PDFX') > 0;
  const rgbRefs = countOccurrences(buf, '/DeviceRGB');
  const cmykRefs = countOccurrences(buf, '/DeviceCMYK');

  // Distinguish RGB *content* from an RGB *resource declaration*. tcolorbox pulls in
  // pgf, which emits `<</pgfprgb[/Pattern/DeviceRGB]>>` -- a declaration of an available
  // pattern colour space that nothing draws with. Reporting that identically to an actual
  // RGB image would make the check cry wolf on a file whose every image is CMYK.
  const pgfOnly = countOccurrences(buf, '/pgfprgb');
  const rgbImagesCount = (run('pdfimages', ['-list', file]).split('\n').slice(2)
    .filter((l) => /\brgb\b/.test(l))).length;

  if (claimsX && rgbRefs > 0 && rgbImagesCount === 0 && rgbRefs <= pgfOnly) {
    add('warning', 'x-rgb-declaration-only',
      `declares ${subtype} and every image is CMYK, but carries ${rgbRefs} ` +
      `/DeviceRGB resource declaration(s) from pgf/tcolorbox`,
      'Nothing draws in RGB -- this is a colour space pgf declares as available. Strictly ' +
      'PDF/X-1a admits no DeviceRGB at all, so a preflight may still reject it. Worth ' +
      'asking the printer rather than assuming either way.');
  } else if (claimsX && rgbRefs > 0) {
    const rgbImages = rgbImagesCount;
    add('error', 'x-claim-vs-colour',
      `declares ${subtype || 'PDF/X'} but contains ${rgbRefs} /DeviceRGB reference(s)` +
      (rgbImages ? ` (${rgbImages} RGB image(s))` : ''),
      'PDF/X-1a permits only CMYK and spot colour. A file that claims the standard and ' +
      'breaks it is worse than one that claims nothing: the claim is what makes a printer ' +
      'skip their own preflight.\n' +
      'Note which part is RGB before scoping a fix. On this book the text and rules are ' +
      'already CMYK -- the template loads xcolor with the cmyk option -- and only the ' +
      'embedded images are RGB, so the fix is image conversion, not document conversion.');
  }
  // Deliberately NOT checking for /DeviceCMYK: CMYK is expressed as `k`/`K` operators
  // inside content streams, not as a named colour space, so its absence proves nothing.
  // Counting the names produced a false positive on a document whose text was already CMYK.

  // --- claim vs content: accessibility ------------------------------------
  // Test the FILE, never pdfinfo's prose. `pdfinfo` prints "Conformance: Level A, Accessible"
  // as its own description of the PDF/X standard, and an earlier version of this script grepped
  // that text and reported a false accessibility claim on a file containing zero occurrences of
  // the word. Only an explicit PDF/UA identifier in the XMP counts as a claim.
  const tagged = /^Tagged:\s*yes/mi.test(info);
  const claimsUA = countOccurrences(buf, 'pdfuaid') > 0;
  if (claimsUA && !tagged) {
    add('error', 'ua-claim-vs-tagging',
      'declares a PDF/UA identifier while reporting Tagged: no',
      'An untagged PDF has no structure tree, so it is not accessible whatever the XMP says.');
  }
  if (!tagged && !claimsUA) {
    add('info', 'not-tagged',
      'not tagged, and claims no PDF/UA conformance — honest, but not accessible');
  }

  // --- fonts: the one X-1a requirement the build already meets -------------
  const missing = fonts.split('\n').slice(2)
    .filter((l) => l.trim() && /\bno\b/.test(l.split(/\s+/).slice(-4)[0] || ''))
    .length;
  const notEmbedded = fonts.split('\n').slice(2).filter((l) => {
    const cols = l.trim().split(/\s+/);
    return cols.length > 4 && cols[cols.length - 4] === 'no';
  });
  if (notEmbedded.length) {
    add('error', 'fonts-not-embedded',
      `${notEmbedded.length} font(s) not embedded`,
      notEmbedded.map((l) => `  ${l.trim().split(/\s+/)[0]}`).join('\n'));
  }

  // --- print-only geometry and extent -------------------------------------
  const pages = parseInt(get('Pages'), 10) || 0;
  const size = get('Page size');
  if (expectPrint) {
    if (/letter|a4/i.test(size)) {
      add('warning', 'trim-size',
        `page size is ${size} — a screen size, not a trade book trim`,
        'No bleed or crop marks are present either. Blocked on the printer\'s specification; ' +
        'see standards-compliance-scope.md A2.');
    }
    for (const n of [16, 8]) {
      if (pages % n !== 0) {
        add('info', 'signature-extent',
          `${pages} pages is not a multiple of ${n} (${n - (pages % n)} short)`);
        break;
      }
    }
  }

  // --- text running past the margin ------------------------------------------
  // This is measured from the FINISHED PDF rather than by parsing LaTeX's log, because
  // pandoc runs xelatex in a temp directory and discards the log: the Overfull \hbox
  // warnings never reach anyone. 64 of 111 pages were overrunning the outer margin after
  // the 6x9 trim change, some past the trim edge entirely, and nothing in the pipeline
  // said a word.
  //
  // A tolerance of 5pt is deliberate. microtype deliberately protrudes punctuation and
  // narrow glyphs a point or two past the margin -- that is correct typography, not a
  // defect, and flagging it would bury the real overruns in ~1000 false positives.
  if (expectPrint) {
    const OVERRUN_TOLERANCE_PT = 5;
    const bbox = run('pdftotext', ['-bbox', file, '-']);
    let pageNo = 0;
    const bad = [];
    for (const l of bbox.split('\n')) {
      if (l.includes('<page ')) { pageNo++; continue; }
      const m = /xMax="([\d.]+)"[^>]*>(.*)<\/word>/.exec(l);
      if (!m || !pageNo) continue;
      // Recto has the wide (inner) margin on the left, verso on the right.
      const limit = pageNo % 2 ? 396 : 378;
      const over = parseFloat(m[1]) - limit;
      if (over >= OVERRUN_TOLERANCE_PT) bad.push({ over, pageNo, word: m[2] });
    }
    if (bad.length) {
      bad.sort((a, b) => b.over - a.over);
      const offPaper = bad.filter((b) => (b.pageNo % 2 ? 396 : 378) + b.over > 432);
      add(offPaper.length ? 'error' : 'warning', 'text-past-margin',
        `${bad.length} word(s) run more than ${OVERRUN_TOLERANCE_PT}pt past the margin` +
        (offPaper.length ? `, ${offPaper.length} past the trim edge` : ''),
        bad.slice(0, 5).map((b) => `  p${b.pageNo}  +${b.over.toFixed(1)}pt  ${b.word.slice(0, 48)}`).join('\n'));
    }
  }

  add('info', 'summary',
    `${pages}pp, ${size}, subtype=${subtype || 'none'}, ` +
    `RGB=${rgbRefs} CMYK=${cmykRefs}, tagged=${tagged ? 'yes' : 'no'}`);

  return findings;
}

// --- typeset faults: a COMPARATOR, not a verdict ----------------------------
// detect-typeset-faults.py scans the finished PDF for the page-break faults a publisher
// reports (figure inside a callout, orphaned tails, ...). It has twice reported zero on
// PDFs where humans found faults, so this check never claims the pages are right. It
// only says what is NEW and what is FIXED relative to a stored baseline.
//
// Two rules keep it safe in a build system shared by other books:
//   * No baseline yet -> write one and carry on. A missing baseline is not a failure.
//   * A detector that cannot run (bad PDF, no pdftotext, no python) THROWS. It is never
//     read as "no faults": that is exactly the failure the detector was fixed to avoid.
const DETECTOR = path.join(__dirname, 'detect-typeset-faults.py');
const FAULT_CLASSES = ['1_figure_in_callout', '2_orphan_tail', '3_word_across_figure',
  '4_widow_orphan', '5_missing_glyph'];

// The digital PDF carries ~36 known faults and is out of scope for this round.
const isDigitalTarget = (file) => path.resolve(file).split(path.sep).includes('digital');

function flatten(report) {
  return FAULT_CLASSES.flatMap((cls) =>
    (report[cls] || []).map((f) => ({ cls, page: f.page, kind: f.kind })));
}

const keyOf = (f) => `${f.cls}|${f.page}|${f.kind}`;

// Both arguments are flat lists of {cls, page, kind}. Identity is class+page+kind: page 105
// reads as a class-2 fault and page 215 as class 1, and the same page in two classes is
// two findings. The detector's free `text` is excluded because it is incidental.
function compareToBaseline(current, baseline) {
  const had = new Set(baseline.map(keyOf));
  const has = new Set(current.map(keyOf));
  return {
    newFindings: current.filter((f) => !had.has(keyOf(f))),
    fixedFindings: baseline.filter((f) => !has.has(keyOf(f))),
  };
}

function runDetector(pdfPath) {
  // Python runs through uv in this project. The detector is stdlib-only.
  const out = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'typeset-')), 'out.json');
  try {
    execFileSync('uv', ['run', '--project', path.join(__dirname, '..'), 'python', DETECTOR,
      pdfPath, '--json', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    if (!(report.page_count > 0)) throw new Error('detector reported no pages');
    return report;
  } catch (e) {
    const why = ((e.stderr || '').toString().trim().split('\n').pop()) || e.message;
    throw new Error(`typeset-fault detector failed on ${pdfPath}: ${why}`);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

function checkTypesetFaults(pdfPath, baselinePath) {
  if (isDigitalTarget(pdfPath)) {
    return { newFindings: [], fixedFindings: [], skipped: true, baselineWritten: false };
  }
  const report = runDetector(pdfPath);
  const current = flatten(report);

  if (!fs.existsSync(baselinePath)) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(report, null, 1) + '\n');
    return { newFindings: [], fixedFindings: [], skipped: false, baselineWritten: true,
      pageCount: report.page_count, currentCount: current.length };
  }

  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    throw new Error(`typeset baseline ${baselinePath} is unreadable (${e.message}); ` +
      'not overwriting it -- fix or delete it deliberately');
  }
  return { ...compareToBaseline(current, flatten(stored)), skipped: false, baselineWritten: false,
    pageCount: report.page_count, currentCount: current.length, baselinePageCount: stored.page_count,
    baselineProvenance: stored.provenance || null };
}

const describeFinding = (f) => `${f.cls.replace('_', ' ')}  p${f.page}  ${f.kind}`;

module.exports = { checkPdf, compareToBaseline, checkTypesetFaults };

if (require.main === module) {
  // The baseline is per book and tracked with it. Override with TYPESET_BASELINE.
  const BASELINE = process.env.TYPESET_BASELINE || 'qa/typeset-baseline.json';
  const targets = [
    { file: 'build/print/constellize-book.pdf', expectPrint: true },
    { file: 'build/digital/constellize-book.pdf', expectPrint: false },
  ];

  let errors = 0, warnings = 0;
  console.log('PDF conformance checks\n');
  for (const t of targets) {
    const rel = path.relative(process.cwd(), t.file);
    console.log(`${DIM}${rel}${RST}`);
    const findings = checkPdf(t.file, t);

    // Typeset-fault comparison, after the conformance checks, print target only.
    if (!t.expectPrint) {
      console.log(`  ${DIM}info    typeset-faults — SKIPPED for the digital target ` +
        `(deferred: ~36 known faults, out of scope this round)${RST}`);
    } else if (fs.existsSync(t.file)) {
      try {
        const r = checkTypesetFaults(t.file, BASELINE);
        if (r.baselineWritten) {
          console.log(`  ${DIM}info    typeset-faults — no baseline at ${BASELINE}; wrote one ` +
            `(${r.currentCount} finding(s), ${r.pageCount}pp). Nothing to compare against yet.${RST}`);
        } else {
          console.log(`  ${DIM}info    typeset-faults — comparison against ${BASELINE}, NOT a ` +
            `verdict that the pages are correct (the detector has missed real faults before). ` +
            `Baseline from ${r.baselineProvenance ? `${r.baselineProvenance.source_pdf} (v${r.baselineProvenance.book_version}, ${r.baselineProvenance.generated_at})` : 'unknown source (no provenance recorded)'}: ` +
            `${r.newFindings.length} new, ${r.fixedFindings.length} fixed` +
            (r.baselinePageCount !== r.pageCount
              ? `; page count ${r.baselinePageCount} -> ${r.pageCount}, so page numbers may have shifted`
              : '') + RST);
          for (const f of r.newFindings) { warnings++; console.log(`  ${YEL}warning${RST} typeset-faults NEW   ${describeFinding(f)}`); }
          for (const f of r.fixedFindings) console.log(`  ${GRN}fixed  ${RST} typeset-faults FIXED ${describeFinding(f)}`);
        }
      } catch (e) {
        errors++;
        console.log(`  ${RED}ERROR${RST}   typeset-faults — ${e.message}`);
      }
    }

    for (const f of findings) {
      if (f.sev === 'error') { errors++; console.log(`  ${RED}ERROR${RST}   ${f.rule} — ${f.msg}`); }
      else if (f.sev === 'warning') { warnings++; console.log(`  ${YEL}warning${RST} ${f.rule} — ${f.msg}`); }
      else console.log(`  ${DIM}info    ${f.rule} — ${f.msg}${RST}`);
      if (f.detail) console.log(`${DIM}${f.detail.split('\n').map((l) => '            ' + l).join('\n')}${RST}`);
    }
    console.log('');
  }

  if (errors) {
    console.log(`${RED}${errors} error(s)${RST}, ${warnings} warning(s)`);
    process.exit(1);
  }
  console.log(`${GRN}No conformance errors${RST}${warnings ? `, ${warnings} warning(s)` : ''}`);
}
