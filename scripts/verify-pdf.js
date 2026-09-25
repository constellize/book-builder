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

  if (claimsX && rgbRefs > 0) {
    const rgbImages = (run('pdfimages', ['-list', file]).split('\n').slice(2)
      .filter((l) => /\brgb\b/.test(l))).length;
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

  add('info', 'summary',
    `${pages}pp, ${size}, subtype=${subtype || 'none'}, ` +
    `RGB=${rgbRefs} CMYK=${cmykRefs}, tagged=${tagged ? 'yes' : 'no'}`);

  return findings;
}

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
