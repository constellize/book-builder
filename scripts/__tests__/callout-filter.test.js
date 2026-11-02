// Round 8, publisher review items 1 and 2: floats must not enter callouts, and a callout
// that could fit on a page must not split and shed an orphaned tail.
//
// WHY THESE ARE THE ONLY TWO LEVERS AVAILABLE (do not re-derive; see
// memory-bank/systemPatterns.md "Callout page breaks"):
//   * tcolorbox's splitting ignores penalties in box CONTENT. An explicit \penalty10000 at
//     the observed break point changed nothing, so \widowpenalty, \brokenpenalty and
//     fancyvrb's own last-line widow penalty are all inert inside a callout.
//   * There is no `lines after break` key. `lines before break` governs only the part BEFORE
//     a split, which is why the publisher's suggested "minimum lines after a break" rule
//     cannot be built.
// So the tail is prevented by NOT SPLITTING a box that could have fitted, and the float is
// kept out by a \FloatBarrier on each side of the box.
//
// These run pandoc to LaTeX only -- no PDF, no xelatex -- so they are fast enough to be the
// inner loop. The rendered-page consequences are measured by the print build and
// scripts/detect-typeset-faults.py.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILTERS = path.resolve(__dirname, '..', '..', 'templates', 'filters');
const BOOK_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENV = { ...process.env, PATH: `${process.env.PATH}:/Library/TeX/texbin:/opt/homebrew/bin` };

function have(cmd) {
  try { execFileSync('which', [cmd], { env: ENV, stdio: 'ignore' }); return true; } catch { return false; }
}
const CAN_RUN = have('pandoc') && fs.existsSync(path.join(FILTERS, 'callout-filter-print.lua'));
if (!CAN_RUN) console.warn('callout-filter tests SKIPPED: need pandoc and the book-builder templates/filters layout');
const maybe = CAN_RUN ? describe : describe.skip;

// The reader extensions the print build uses, trimmed to what these fixtures need. The
// fenced_divs extension is the load-bearing one: without it `::: code` is a paragraph.
const FROM = 'markdown+fenced_divs+raw_attribute+footnotes+implicit_figures+link_attributes';

let tmp;

// The print pipeline's filter order, as pandoc-defaults-print.yaml runs it: minted first,
// then the lead-in filter (while callouts are still Divs), then the callout filter.
function pandocToLatex(md) {
  const file = path.join(tmp, `in-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(file, md);
  return execFileSync('pandoc', [
    file, '-f', FROM, '-t', 'latex',
    `--lua-filter=${path.join(FILTERS, 'minted-filter.lua')}`,
    `--lua-filter=${path.join(FILTERS, 'keep-leadin-with-content.lua')}`,
    `--lua-filter=${path.join(FILTERS, 'callout-filter-print.lua')}`,
  ], { env: ENV, cwd: BOOK_ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
}

// One line per top-level block of the filtered document: "<Type>|<text>". See
// fixtures/dump-blocks.lua for why the structure cannot simply be read with `-t native`.
function dumpBlocks(md) {
  const file = path.join(tmp, `ast-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(file, md);
  return execFileSync('pandoc', [
    file, '-f', FROM, '-t', 'latex',
    `--lua-filter=${path.join(FILTERS, 'minted-filter.lua')}`,
    `--lua-filter=${path.join(FILTERS, 'callout-filter-print.lua')}`,
    `--lua-filter=${path.join(__dirname, 'fixtures', 'dump-blocks.lua')}`,
  ], { env: ENV, cwd: BOOK_ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').filter(Boolean);
}

const countOccurrences = (s, needle) => s.split(needle).length - 1;

// A `::: code` callout holding an n-line JSON listing, shaped like ch3.md:62-78.
const codeCallout = n => '::: code\n\n```json\n{\n' +
  Array.from({ length: Math.max(0, n - 2) }, (_, i) => `  "key${i}": "value${i}",`).join('\n') +
  '\n}\n```\n\n:::\n';

const imageCallout = () =>
  '::: info\n![A diagram that carries the whole callout](images/diagrams/ch8/personal-to-team-knowledge-flow.excalidraw.png)\n:::\n';

const conversationCallout = () => [
  '::: conversation',
  '**Human:** How do I map what already works?',
  '',
  '**AI:** Start from the health endpoints you already ship.',
  '',
  '**Reflection:** The inventory was the deliverable, not the preamble.',
  ':::',
  ''].join('\n');

// The real shape of the four promptref instances the detector found on pp.105/108/112/141:
// two short paragraphs and a Link: line whose footnote is a bare URL.
const promptRefCallout = (paras = 2) => [
  '::: {.promptref title="Design Actionable Health Reporting" url="https://constellize.com/prompts/v1/design-actionable-health-reporting"}',
  ...Array.from({ length: paras }, (_, i) =>
    `**Paragraph ${i}** describing what the prompt does, at about the length the book actually uses for these, which is two or three lines of the measure.\n`),
  ':::',
  ''].join('\n');

maybe('callout filter: float barriers', () => {
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'callout-')); });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('a float barrier precedes and follows every callout', () => {
    const tex = pandocToLatex('::: info\nhello\n:::\n');
    expect(tex).toMatch(/\\FloatBarrier[\s\S]*\\begin\{tcolorbox\}[\s\S]*\\FloatBarrier/);
  });

  test('promptref and conversation callouts are barriered too', () => {
    for (const md of [promptRefCallout(), conversationCallout()]) {
      expect(pandocToLatex(md)).toMatch(/\\FloatBarrier[\s\S]*\\begin\{tcolorbox\}[\s\S]*\\FloatBarrier/);
    }
  });

  // THE TRAP. keep-leadin-with-content.lua identifies a callout by matching a LaTeX RawBlock
  // containing \begin{ and reserves 9 lines for it; anything else gets the generic 5. A
  // barrier emitted as its OWN RawBlock would be what that filter sees, so the callout would
  // silently drop to 5 lines and re-strand the lead-ins rounds 5 and 6 closed.
  test('a lead-in before a callout still reserves nine lines, not five', () => {
    const tex = pandocToLatex('As follows:\n\n::: info\nhello\n:::\n');
    expect(tex).toMatch(/\\needspaceNow\{9\\baselineskip\}/);
    expect(tex).not.toMatch(/\{5\\baselineskip\}/);
  });

  // placeins' \FloatBarrier issues a \newpage when floats are actually held. In front of a
  // callout that break landed BETWEEN the lead-in and the box: "For Stale Memory Banks ...:"
  // at the foot of p.156 with Figure 5.4 and the callout overleaf. The barrier has to be
  // issued ahead of the reservation so the lead-in and its box travel together.
  test('a lead-in dumps held floats before reserving, and reserves eagerly', () => {
    // Eager, not lazy: \needspace leaves `\vskip 0pt plus 9\baselineskip` behind, and with
    // an unbreakable box as the next legal breakpoint that stretch buys a three-line page
    // (p.118 of the round-8 build: three lines, 90% white, shipped at badness 3861).
    expect(pandocToLatex('As follows:\n\n::: info\nhello\n:::\n')).toMatch(
      /\\ifdefined\\FloatBarrier\\FloatBarrier\\fi\\ifdefined\\needspaceNow\\needspaceNow\{9\\baselineskip\}\\else\\needspace\{9\\baselineskip\}\\fi/);
  });

  test('a lead-in before a plain Div does not dump floats', () => {
    // A Div can be a crossref wrapper or a size switch. Dumping floats in front of one of
    // those would cost pages for nothing, and no barrier follows it anyway.
    const tex = pandocToLatex('As follows:\n\n::: {.sizeswitch}\nhello\n:::\n');
    expect(tex).toMatch(/\\needspace\{9\\baselineskip\}/);
    expect(tex).not.toMatch(/\\FloatBarrier/);
  });

  test('the barrier travels in the same raw block as the box it guards', () => {
    // Asserted on the BLOCK STRUCTURE, not the rendered LaTeX: in the .tex a barrier in its
    // own block and a barrier inside the box's block look identical, and it is the block
    // boundary that keep-leadin-with-content.lua reads.
    const blocks = dumpBlocks('::: info\nhello\n:::\n')
      .filter(l => /FloatBarrier|tcolorbox/.test(l));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatch(/^RawBlock\|.*\\FloatBarrier.*\\begin\{tcolorbox\}/);
  });
});

maybe('callout filter: a callout that fits does not split', () => {
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calloutfit-')); });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('a short code callout is not breakable', () => {
    expect(pandocToLatex(codeCallout(16))).toMatch(/breakable=false/);
  });

  test("the book's own p80 JSON listing is pinned", () => {
    // ch3.md:62-78 verbatim: the instance the publisher reported, whose tail "] } } } }"
    // opened p80.
    const json = fs.readFileSync(path.join(BOOK_ROOT, 'ch3.md'), 'utf8')
      .split('\n').slice(59, 80).join('\n');
    expect(json).toMatch(/clientConfigServer/); // the fixture really is that listing
    expect(pandocToLatex(json)).toMatch(/breakable=false/);
  });

  test('a short promptref callout is not breakable', () => {
    // Four of the five class-2 instances are promptref boxes whose Link: footnote was
    // orphaned overleaf, so the fix has to cover these and not only ::: code.
    expect(pandocToLatex(promptRefCallout(2))).toMatch(/breakable=false/);
  });

  test('a callout taller than a page stays breakable', () => {
    // Pinning this would overrun the text block, not split it: an Overfull \vbox, which is
    // worse than the orphan it was meant to prevent.
    expect(pandocToLatex(codeCallout(200))).not.toMatch(/breakable=false/);
  });

  test('a long promptref callout stays breakable', () => {
    expect(pandocToLatex(promptRefCallout(40))).not.toMatch(/breakable=false/);
  });

  test('a callout containing only an image is not pinned as zero-height', () => {
    // An image measures as no text lines at all, so a naive line count would call this the
    // shortest box in the book and pin a full-page figure.
    expect(pandocToLatex(imageCallout())).not.toMatch(/breakable=false/);
  });

  test('conversation callouts keep their nested boxes intact', () => {
    const tex = pandocToLatex(conversationCallout());
    expect(countOccurrences(tex, '\\begin{tcolorbox}')).toBeGreaterThan(1);
  });
});
