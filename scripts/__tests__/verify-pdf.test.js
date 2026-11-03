/**
 * Tests for the typeset-fault comparator in verify-pdf.js.
 *
 * The comparator is deliberately NOT a pass/fail verdict on the pages: the detector has
 * twice reported zero on PDFs where humans found faults. These tests therefore pin the
 * comparison logic and, above all, that a book with no baseline is never failed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareToBaseline, checkTypesetFaults, summaryLines } = require('../verify-pdf');

const finding = (cls, page, kind) => ({ cls, page, kind });

const baseline = [
  finding('2_orphan_tail', 80, 'lone closer'),
  finding('2_orphan_tail', 105, 'callout footnote orphaned at page head'),
  finding('1_figure_in_callout', 215, 'callout footnote displaced past figure'),
];

// A one-page PDF with a single line of text. pdftotext rebuilds a missing xref, so the
// offsets need not be exact; it is a real PDF the real detector can read.
function writeTinyPdf(file) {
  const stream = 'BT /F1 12 Tf 72 700 Td (Hello typesetting) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, out, 'latin1');
}

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pdf-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('compareToBaseline', () => {
  test('reports only findings absent from the baseline', () => {
    const current = [...baseline, finding('2_orphan_tail', 42, 'lone brace')];
    const r = compareToBaseline(current, baseline);
    expect(r.newFindings).toEqual([finding('2_orphan_tail', 42, 'lone brace')]);
    expect(r.fixedFindings).toEqual([]);
  });

  test('reports findings the baseline had and the build does not as fixed', () => {
    const current = baseline.filter((f) => f.page !== 80);
    const r = compareToBaseline(current, baseline);
    expect(r.fixedFindings).toContainEqual(expect.objectContaining({ page: 80 }));
    expect(r.newFindings).toEqual([]);
  });

  test('the same page in a different class is a different finding', () => {
    const r = compareToBaseline([finding('1_figure_in_callout', 105, 'x')], baseline);
    expect(r.newFindings).toHaveLength(1);
    expect(r.fixedFindings).toHaveLength(3);
  });

  test('identical findings produce neither new nor fixed', () => {
    expect(compareToBaseline(baseline, baseline)).toEqual({ newFindings: [], fixedFindings: [] });
  });
});

describe('checkTypesetFaults', () => {
  test('writes a baseline and does not fail when none exists', () => {
    const pdf = path.join(tmp, 'build', 'print', 'book.pdf');
    fs.mkdirSync(path.dirname(pdf), { recursive: true });
    writeTinyPdf(pdf);
    const baselinePath = path.join(tmp, 'qa', 'not-yet', 'baseline.json');   // dir absent too

    const r = checkTypesetFaults(pdf, baselinePath);

    expect(r.skipped).toBe(false);
    expect(r.baselineWritten).toBe(true);
    expect(r.newFindings).toEqual([]);
    expect(fs.existsSync(baselinePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    expect(written.page_count).toBe(1);
    // A stable, version-less filename means provenance must live inside the file.
    expect(written.provenance).toEqual(expect.objectContaining({
      source_pdf: pdf, generated_at: expect.any(String) }));
    expect(written.provenance).toHaveProperty('book_version');
  });

  test('compares against an existing baseline without overwriting it', () => {
    const pdf = path.join(tmp, 'build', 'print', 'book.pdf');
    fs.mkdirSync(path.dirname(pdf), { recursive: true });
    writeTinyPdf(pdf);
    const baselinePath = path.join(tmp, 'baseline.json');
    const stored = {
      '1_figure_in_callout': [], '3_word_across_figure': [], '4_widow_orphan': [],
      '5_missing_glyph': [], page_count: 1,
      '2_orphan_tail': [{ page: 80, text: ']', kind: 'lone closer' }],
    };
    fs.writeFileSync(baselinePath, JSON.stringify(stored));

    const r = checkTypesetFaults(pdf, baselinePath);

    expect(r.baselineWritten).toBe(false);
    expect(r.fixedFindings).toEqual([expect.objectContaining({ page: 80, cls: '2_orphan_tail' })]);
    expect(JSON.parse(fs.readFileSync(baselinePath, 'utf8'))).toEqual(stored);
  });

  test('skips when the caller names the digital target, without reading the PDF', () => {
    const digital = path.join(tmp, 'build', 'digital', 'book.pdf');   // does not exist
    const baselinePath = path.join(tmp, 'baseline.json');
    const r = checkTypesetFaults(digital, baselinePath, { target: 'digital' });
    expect(r.skipped).toBe(true);
    expect(fs.existsSync(baselinePath)).toBe(false);
  });

  test('a print PDF under an ancestor directory called "digital" is still measured', () => {
    const pdf = path.join(tmp, 'digital', 'mybook', 'build', 'print', 'book.pdf');
    fs.mkdirSync(path.dirname(pdf), { recursive: true });
    writeTinyPdf(pdf);
    const baselinePath = path.join(tmp, 'digital', 'mybook', 'qa', 'baseline.json');
    const r = checkTypesetFaults(pdf, baselinePath);
    expect(r.skipped).toBe(false);
    expect(r.baselineWritten).toBe(true);
  });

  test('an unreadable PDF is an error, never "no faults" and never a baseline', () => {
    const pdf = path.join(tmp, 'build', 'print', 'broken.pdf');
    fs.mkdirSync(path.dirname(pdf), { recursive: true });
    fs.writeFileSync(pdf, 'this is not a pdf');
    const baselinePath = path.join(tmp, 'baseline.json');
    expect(() => checkTypesetFaults(pdf, baselinePath)).toThrow();
    expect(fs.existsSync(baselinePath)).toBe(false);
  });

  test('a corrupt baseline is an error and is not overwritten', () => {
    const pdf = path.join(tmp, 'build', 'print', 'book.pdf');
    fs.mkdirSync(path.dirname(pdf), { recursive: true });
    writeTinyPdf(pdf);
    const baselinePath = path.join(tmp, 'baseline.json');
    fs.writeFileSync(baselinePath, '{ not json');
    expect(() => checkTypesetFaults(pdf, baselinePath)).toThrow(/baseline/i);
    expect(fs.readFileSync(baselinePath, 'utf8')).toBe('{ not json');
  });
});

describe('missing prerequisites are "not measured", not a failure and not a clean pass', () => {
  const realPath = process.env.PATH;
  afterEach(() => { process.env.PATH = realPath; });

  function printPdf() {
    const pdf = path.join(tmp, 'build', 'print', 'book.pdf');
    fs.mkdirSync(path.dirname(pdf), { recursive: true });
    writeTinyPdf(pdf);
    return pdf;
  }

  test('no uv and no pdftotext on PATH: notRun with a reason, nothing thrown or written', () => {
    const pdf = printPdf();
    const baselinePath = path.join(tmp, 'baseline.json');
    const empty = path.join(tmp, 'empty-bin');
    fs.mkdirSync(empty);
    process.env.PATH = empty;
    const r = checkTypesetFaults(pdf, baselinePath);
    expect(r.notRun).toBe(true);
    expect(r.reason).toMatch(/pdftotext|uv/);
    expect(r.newFindings).toEqual([]);
    expect(fs.existsSync(baselinePath)).toBe(false);
  });

  test('pdftotext present but uv absent: notRun naming uv', () => {
    const pdf = printPdf();
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const which = require('child_process').execFileSync('which', ['pdftotext'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(which, path.join(bin, 'pdftotext'));
    process.env.PATH = bin;
    const r = checkTypesetFaults(pdf, path.join(tmp, 'baseline.json'));
    expect(r.notRun).toBe(true);
    expect(r.reason).toMatch(/uv/);
  });

  test('uv runs and exits 0 but writes no JSON: the detector failed, so ERROR, not notRun', () => {
    const pdf = printPdf();
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const which = require('child_process').execFileSync('which', ['pdftotext'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(which, path.join(bin, 'pdftotext'));
    fs.writeFileSync(path.join(bin, 'uv'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = bin;
    const baselinePath = path.join(tmp, 'baseline.json');
    expect(() => checkTypesetFaults(pdf, baselinePath)).toThrow(/detector failed/);
    expect(fs.existsSync(baselinePath)).toBe(false);
  });
});

// I-3. The design asked for `Overfull \vbox` to fail the build; it shipped as a warning,
// because book-builder is shared. The exit code therefore cannot be the signal, so the LAST
// LINE has to be: a build with five fresh orphaned callout tails and a 40pt box hanging off
// the bottom of a page used to end on `No conformance errors, 6 warning(s)`, which reads
// exactly like six cosmetic warnings. `notMeasured` did not cover it either -- that fires
// when a check did not RUN, not when a check ran and found the publisher's faults again.
describe('summaryLines: the last line distinguishes faults from cosmetic warnings', () => {
  const text = (r) => summaryLines(r).map((l) => l.text).join('\n');
  const sevs = (r) => summaryLines(r).map((l) => l.sev);

  test('a clean build reads clean', () => {
    expect(sevs({ warnings: 0 })).toEqual(['ok']);
    expect(text({ warnings: 0 })).toBe('No conformance errors');
  });

  test('cosmetic warnings say in so many words that they are not typeset faults', () => {
    expect(sevs({ warnings: 3 })).toEqual(['ok']);
    expect(text({ warnings: 3 })).toMatch(/none of them a new typeset fault or an Overfull \\vbox/);
  });

  test('new class-1/class-2 findings are named, with their pages, and the line is not ok', () => {
    const r = { warnings: 6, newFindings: [
      { cls: '2_orphan_tail', page: 105, kind: 'footnote' },
      { cls: '2_orphan_tail', page: 108, kind: 'footnote' },
      { cls: '1_figure_in_callout', page: 215, kind: 'figure' },
    ] };
    expect(sevs(r)).not.toContain('ok');
    const t = text(r);
    expect(t).toMatch(/3 NEW class-1\/class-2 typeset fault\(s\)/);
    expect(t).toMatch(/p105 p108 p215/);
    // The phrase a reader scanning for "is this fine" would stop on.
    expect(t).toMatch(/INCLUDING REAL TYPESET FAULTS/);
  });

  test('a non-zero Overfull \\vbox count is named on its own', () => {
    // The asymmetric cost of pinning: no new detector finding, but a box ran off the page.
    const r = { warnings: 1, overfullVboxes: 1 };
    expect(sevs(r)).not.toContain('ok');
    expect(text(r)).toMatch(/1 Overfull \\vbox/);
  });

  test('zero Overfull boxes and no new findings stay in the clean branch', () => {
    expect(sevs({ warnings: 2, overfullVboxes: 0, newFindings: [] })).toEqual(['ok']);
  });

  test('classes 3-5 are reported, but apart from the publisher\'s own two', () => {
    const t = text({ warnings: 4, newFindings: [{ cls: '4_widow_orphan', page: 75, kind: 'orphan' }] });
    expect(t).toMatch(/1 new typeset fault\(s\) in classes 3-5/);
    expect(t).not.toMatch(/class-1\/class-2/);
  });

  test('NOT MEASURED keeps its caveat and makes no claim about what was not measured', () => {
    const t = text({ warnings: 1, notMeasured: true });
    expect(t).toMatch(/NOT MEASURED/);
    expect(t).not.toMatch(/none of them/);
  });

  test('a conformance error prints the error line and no clean line', () => {
    expect(sevs({ errors: 2, warnings: 1 })).toEqual(['error']);
    expect(text({ errors: 2, warnings: 1 })).toBe('2 error(s), 1 warning(s)');
  });
});
