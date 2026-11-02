// Regression tests for the "ghost table header" (round 7, p.184): a longtable head with rules
// and no body, printed at the top of a page ABOVE the lead-in sentence that precedes the table
// in the source. Cause: \needspace's deferred break is taken inside longtable's output
// routine, which copies the head to the top of the next page. See \needspaceNow in
// templates/book-print.latex.
//
// These build real PDFs with pandoc + xelatex using the print defaults, template and filters,
// sweeping the amount of text before the table so that the table starts at many different
// distances from the foot of the page. A single filler count proves little: the fault only
// appears when the table starts in a particular band.
//
// The book has two tables. ch7.md:64 was the ghost; ch8.md:274 runs across p.219-220 and
// correctly repeats its head on the continuation page. The second test pins that: a fix that
// removed continuation heads would pass the first test and fail the second.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

const BOOK_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULTS = path.join(BOOK_ROOT, 'book-builder', 'config', 'pandoc-defaults-print.yaml');
const TEMPLATE = path.join(BOOK_ROOT, 'book-builder', 'templates', 'book-print.latex');
const FIXTURES = path.join(__dirname, 'fixtures');
const TEXBIN = '/Library/TeX/texbin';
const ENV = { ...process.env, PATH: `${process.env.PATH}:${TEXBIN}:/opt/homebrew/bin` };

function have(cmd) {
  try { execFileSync('which', [cmd], { env: ENV, stdio: 'ignore' }); return true; } catch { return false; }
}
// pandoc-crossref is a filter in the print defaults, so it is a prerequisite too.
const CAN_BUILD = fs.existsSync(DEFAULTS) && fs.existsSync(TEMPLATE) &&
  ['pandoc', 'xelatex', 'pdftotext', 'pandoc-crossref'].every(have);
const maybe = CAN_BUILD ? describe : describe.skip;
if (!CAN_BUILD) console.warn('table-boundary tests SKIPPED: need pandoc, pandoc-crossref, xelatex, pdftotext and the book-builder submodule layout');

const HEADER = /Factor\s+Favors Separate\s+Favors Integrated/;
const BODY = /Dedicated|Strict separation|Unified toolchain|Operational procedures|handoffs|Large organizations|Row \d\d factor/;
const LEADIN = /consider these factors:|long enough to run across a page break:/;

let tmp;
const fillerFile = (name, n) =>
  fs.readFileSync(path.join(FIXTURES, name), 'utf8').replace('@@FILLER@@',
    Array.from({ length: n }, (_, i) =>
      `Filler paragraph number ${i} with enough words to take a couple of lines of the measure so that the page fills predictably.`
    ).join('\n\n'));

async function build(fixture, n, transform = x => x, tag = '') {
  const base = `${fixture.replace(/\.md$/, '')}${tag}-${n}`;
  const md = path.join(tmp, `${base}.md`), pdf = path.join(tmp, `${base}.pdf`);
  fs.writeFileSync(md, transform(fillerFile(fixture, n)));
  await run('pandoc', [md, `--defaults=${DEFAULTS}`, `--template=${TEMPLATE}`, '-o', pdf],
    { cwd: BOOK_ROOT, env: ENV, maxBuffer: 64 << 20 });
  const text = (await run('pdftotext', ['-layout', pdf, '-'], { env: ENV, maxBuffer: 64 << 20 })).stdout;
  return text.split('\f');
}

// Pages that carry any part of the table (a head or a body row).
const tablePages = pages => pages.map((t, i) => ({ t, i })).filter(({ t }) => HEADER.test(t) || BODY.test(t));
// First line (after the running head / folio) of a page's text.
const lines = t => t.split('\n').map(l => l.trim()).filter(Boolean);

maybe('longtable head never ships without a body', () => {
  jest.setTimeout(600000);
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tblbound-')); });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // 6-row table. Before the fix, 4 of these 14 (n=15,17,18,19) produced the ghost.
  const SWEEP = Array.from({ length: 14 }, (_, i) => 12 + i);

  // The same table behind a fenced Div, which is how a crossref wrapper or a size switch
  // reaches the filter. The filter must look through it, or the lazy \\needspace returns.
  const wrapInDiv = md => md.replace(/^(\| Factor[\s\S]*?\n)\n(A closing)/m, '::: {.tablebox}\n$1:::\n\n$2');

  async function ghostFaults(transform, tag) {
    const results = await Promise.all(SWEEP.map(async n => ({ n, pages: await build('table-at-page-boundary.md', n, transform, tag) })));
    const faults = [];
    for (const { n, pages } of results) {
      expect(tablePages(pages).length).toBeGreaterThan(0); // the table was actually rendered
      pages.forEach((t, i) => {
        if (!HEADER.test(t)) return;
        if (!BODY.test(t)) faults.push(`n=${n} p${i + 1}: head with no body`);
        const L = t.search(LEADIN), H = t.search(HEADER);
        if (L >= 0 && H < L) faults.push(`n=${n} p${i + 1}: head printed above its lead-in`);
      });
    }
    return faults;
  }

  test('no page prints a table head above its lead-in, and none prints a head with no body', async () => {
    expect(await ghostFaults(x => x, '')).toEqual([]);
  });

  test('the same holds when the table sits inside a Div wrapper', async () => {
    const wrapped = wrapInDiv(fillerFile('table-at-page-boundary.md', 0));
    expect(wrapped).toMatch(/::: \{\.tablebox\}/); // the wrapper really was applied
    expect(await ghostFaults(wrapInDiv, '-div')).toEqual([]);
  });

  test('a table that genuinely breaks still repeats its head on the continuation page', async () => {
    // 30-row table: always longer than a page, so it must split. Every page after the first
    // that carries the table must open with the head, directly followed by body rows.
    const results = await Promise.all([8, 10, 12, 14].map(async n => ({ n, pages: await build('table-spanning-pages.md', n) })));
    for (const { n, pages } of results) {
      const tp = tablePages(pages);
      expect(`n=${n} table pages=${tp.length}`).not.toMatch(/pages=1$/); // it really did split
      tp.slice(1).forEach(({ t, i }) => {
        const body = lines(t).filter(l => !/^\d+$/.test(l) && !/Chapter \d/.test(l));
        // first content line on a continuation page is the head, and a body row follows it
        expect(`n=${n} p${i + 1}: ${HEADER.test(body[0]) ? 'head first' : 'NO head first: ' + body[0]}`).toMatch(/head first/);
        expect(`n=${n} p${i + 1}: ${BODY.test(body[1] || '') ? 'body follows' : 'NO body after head: ' + body[1]}`).toMatch(/body follows/);
      });
    }
  });
});

// The contents page: a three-digit page number against a title long enough to fill its line.
// The book class sizes the number box for two digits; three overflowed it and the number was
// set hard against the last word ("...Systematic Planning189") with no leaders.
maybe('contents page numbers', () => {
  jest.setTimeout(600000);
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tocnum-')); });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('a three-digit page number never touches its title and keeps its leader dots', async () => {
    const pages = await build('toc-three-digit-page.md', 0);
    const toc = pages.find(t => /Contents/.test(t) && /Systematic/.test(t));
    expect(toc).toBeDefined();
    const ls = lines(toc);
    const i = ls.findIndex(l => /Systematic/.test(l));
    // The entry may wrap; gather it up to the line that carries the page number.
    const entry = [];
    for (let k = i; k < ls.length && entry.length < 3; k++) { entry.push(ls[k]); if (/\d{3}$/.test(ls[k])) break; }
    const last = entry[entry.length - 1];
    expect(last).toMatch(/\d{3}$/);                  // a three-digit number is there
    expect(last).not.toMatch(/[A-Za-z]\d{3}$/);      // not set against the last word
    expect(last).toMatch(/\. \. \./);                // and the leader run survives
  });
});
