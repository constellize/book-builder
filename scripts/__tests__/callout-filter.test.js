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
const TEMPLATES = path.resolve(__dirname, '..', '..', 'templates');
const BOOK_ROOT = path.resolve(__dirname, '..', '..', '..');
const { readCalloutPinBudget } = require('../lib/callout-pin-budget.js');
const ENV = { ...process.env, PATH: `${process.env.PATH}:/Library/TeX/texbin:/opt/homebrew/bin` };

function have(cmd) {
  try { execFileSync('which', [cmd], { env: ENV, stdio: 'ignore' }); return true; } catch { return false; }
}
const CAN_RUN = have('pandoc') && fs.existsSync(path.join(FILTERS, 'callout-filter-print.lua'));
if (!CAN_RUN) console.warn('callout-filter tests SKIPPED: need pandoc and the book-builder templates/filters layout');
const maybe = CAN_RUN ? describe : describe.skip;

// book-builder is a submodule shared between books. One test below reads the Constellize
// manuscript, which is simply not there in a standalone clone or in examples/sample-book --
// that test skips, rather than failing the suite with ENOENT.
const MANUSCRIPT = path.join(BOOK_ROOT, 'ch3.md');
const withManuscript = fs.existsSync(MANUSCRIPT) ? test : test.skip;

// The reader extensions the print build uses, trimmed to what these fixtures need. The
// fenced_divs extension is the load-bearing one: without it `::: code` is a paragraph.
const FROM = 'markdown+fenced_divs+raw_attribute+footnotes+implicit_figures+link_attributes'
  // line_blocks and escaped_line_breaks are both on in pandoc-defaults-print.yaml, and both
  // are paths into the estimator that bypassed its Image/Note guard. Keep them here.
  + '+line_blocks+escaped_line_breaks'
  // inline_notes is on in the print defaults too, and `^[...]` reaches the Note handler by a
  // different route from a `[^1]` reference. Both were costed at a flat 32pt.
  + '+inline_notes';

// Pinning is OFF unless the TEMPLATE declares a budget (I-1): book-builder is shared, the
// print defaults name no template, and the estimator's constants describe one page geometry.
// build-book.js reads \calloutPinBudget out of the template and forwards it as metadata, so
// these tests have to supply it the same way or nothing would ever be pinned -- which is
// what the gate test below asserts.
const PIN_BUDGET_META = `--metadata=callout-pin-budget:${readCalloutPinBudget(
  fs.readFileSync(path.join(TEMPLATES, 'book-print.latex'), 'utf8'))}`;

let tmp;

// The print pipeline's filter order, as pandoc-defaults-print.yaml runs it: minted first,
// then the lead-in filter (while callouts are still Divs), then the callout filter.
function pandocToLatex(md, extraArgs = [PIN_BUDGET_META]) {
  const file = path.join(tmp, `in-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(file, md);
  return execFileSync('pandoc', [
    file, '-f', FROM, '-t', 'latex', ...extraArgs,
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
    file, '-f', FROM, '-t', 'latex', PIN_BUDGET_META,
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
      .filter(l => /FloatBarrier|tcolorbox|CALLOUTFIT/.test(l));
    expect(blocks).toHaveLength(1);
    // The %%CALLOUTFIT provenance comment rides in the SAME block, and that matters for the
    // same reason the barrier does: emitted as its own RawBlock it would be the block
    // keep-leadin-with-content.lua matched, and the callout would drop to five lines.
    // pinned=0: a one-word `::: info` fits a page but has no strandable tail, so since round
    // 8's second pass it is left breakable. What this test guards is the BLOCK STRUCTURE, not
    // the pin decision -- the barrier and the provenance comment riding in the same block.
    expect(blocks[0]).toMatch(
      /^RawBlock\|.*\\FloatBarrier.*%%CALLOUTFIT[^\n]*?type=info[^\n]*?pinned=0 .*\\begin\{tcolorbox\}/);
  });
});

maybe('callout filter: a callout that fits does not split', () => {
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calloutfit-')); });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('a short code callout is not breakable', () => {
    // codeCallout() emits JSON, so its last line is `}` -- a strandable tail, hence pinned.
    expect(pandocToLatex(codeCallout(16))).toMatch(/breakable=false/);
  });

  // Round 8, second pass. Pinning every box that merely FITS pinned 123 of the book's 157
  // callouts and cost ten pages and 17.5 pages' worth of whitespace, because a pinned box
  // that does not fit where it stands moves on and leaves its hole behind. Fit asks "may this
  // be pinned", not "need it be". These two tests are the difference, and they are deliberately
  // the same height so that only the tail can explain the different answer.
  const SHELL_LINES = 16;
  const shellCallout = () => '::: code\n\n```bash\n' +
    Array.from({ length: SHELL_LINES },
      (_, i) => `echo "step ${i} of the build completed"`).join('\n') +
    '\n```\n\n:::\n';

  test('a code callout that does NOT end in a closer stays breakable', () => {
    const tex = pandocToLatex(shellCallout());
    // It fits -- so the only thing leaving it breakable is the absence of a strandable tail.
    // Asserting both together is what stops this passing because the box became unmeasurable.
    expect(tex).toMatch(/%%CALLOUTFIT[^\n]*?type=code[^\n]*?pinned=0 est=\d+\.\d+ .*fits=1/);
    expect(tex).not.toMatch(/breakable=false/);
  });

  test('the same box pinned once a closer is appended to it', () => {
    const withTail = shellCallout().replace('\n```\n\n:::', '\n}\n```\n\n:::');
    expect(pandocToLatex(withTail)).toMatch(/breakable=false/);
  });

  withManuscript("the book's own p80 JSON listing is pinned", () => {
    // ch3.md:62-78 verbatim: the instance the publisher reported, whose tail "] } } } }"
    // opened p80.
    const json = fs.readFileSync(MANUSCRIPT, 'utf8')
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

  // I-1. A line block measured its own inlines and never went through the Image/Note guard,
  // so a half-page diagram inside one estimated at about 66pt and the box was pinned -- which
  // does not warn, it hangs xelatex.
  test('an image inside a LINE BLOCK is not pinned as two lines of text', () => {
    const tex = pandocToLatex('::: info\n| ![d](images/diagrams/ch8/personal-to-team-knowledge-flow.excalidraw.png)\n| second line\n:::\n');
    expect(tex).toMatch(/includegraphics|pandocbounded/); // the line block really holds the image
    expect(tex).not.toMatch(/breakable=false/);
  });

  test('a footnote inside a line block is counted, not ignored', () => {
    // The same bypass dropped Notes. Twenty SHORT lines measure at about 360pt and fit, so
    // the box is pinned if the footnotes are free; the twenty footnote bodies are worth far
    // more than the remaining budget, so counting them is what keeps it breakable.
    const body = Array.from({ length: 20 }, (_, i) => `| line ${i}[^${i}]`).join('\n');
    const defs = Array.from({ length: 20 }, (_, i) =>
      `[^${i}]: https://constellize.com/prompts/v1/a-reasonably-long-footnote-url-${i}`).join('\n');
    const tex = pandocToLatex(`::: info\n${body}\n:::\n\n${defs}\n`);
    expect(tex).toMatch(/\\footnote/);           // the footnotes really are inside the box
    expect(tex).not.toMatch(/breakable=false/);
  });

  // I-2. pandoc.utils.stringify() flattens a LineBreak to a space, so a paragraph written
  // with trailing-double-space hard breaks measured as one long wrapped run while the
  // renderer sets one line per break -- about a third of the true height. The manuscript
  // already writes such breaks (ch1.md:138-141, ch5.md:46, ch5.md:71, introduction.md:184);
  // none is inside a callout yet, which is the only reason the build still terminates.
  test('hard line breaks are counted as lines, not flattened to spaces', () => {
    // 40 short hard-broken lines: ~22 characters each, so one wrapped run would measure as
    // about 18 lines and the real box is 40.
    const hard = Array.from({ length: 40 }, (_, i) => `line number ${i} here  `).join('\n');
    const tex = pandocToLatex(`::: info\n${hard}\n:::\n`);
    expect(tex).toMatch(/\\\\/);              // the hard breaks really survived into LaTeX
    expect(tex).not.toMatch(/breakable=false/);
  });

  test('a hard break nested inside formatting makes the box unmeasurable', () => {
    // lines_of_inlines() only splits the TOP-level inline list. A LineBreak inside Strong is
    // one it cannot place, so the honest answer is "do not pin".
    const inner = Array.from({ length: 40 }, (_, i) => `**bold line ${i}  `).join('\n') + '**';
    expect(pandocToLatex(`::: info\n${inner}\n:::\n`)).not.toMatch(/breakable=false/);
  });

  test('a short hard-broken callout is still MEASURED', () => {
    // The fix must not make every hard break unmeasurable: four short lines still fit.
    //
    // Asserted on `fits=1`, not on breakable=false. This box has no strandable tail, so since
    // round 8's second pass it is deliberately left breakable -- but the thing under test is
    // the ESTIMATOR, which must still place the hard breaks and return a height. Asserting
    // the pin decision here would silently stop testing that: an unmeasurable box also comes
    // out breakable, so the old assertion would now pass for exactly the wrong reason.
    const hard = Array.from({ length: 4 }, (_, i) => `line number ${i} here  `).join('\n');
    const tex = pandocToLatex(`::: info\n${hard}\n:::\n`);
    expect(tex).toMatch(/%%CALLOUTFIT[^\n]*?type=info[^\n]*?pinned=0 est=\d+\.\d+ .*fits=1/);
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

  // C-1, the THIRD instance of the same blind spot. pandoc.utils.stringify() applies deNote,
  // so stringify(note) is "" for every footnote ever written: wrapped("") is 1, max(2,1) is 2,
  // and EVERY footnote cost exactly note_base + 2 note_lines = 32pt whatever its real height.
  // The body is reached through note.content.
  //
  // 18 one-line paragraphs estimate at ~294pt, which fits; the footnote below is ~2,800
  // characters, which is ~70 lines of footnote text and ~780pt on its own. Costed at 32pt the
  // box estimated at 359.76pt and was PINNED, against a true height near 1,218pt -- a pinned
  // box that does not fit does not warn, it hangs xelatex.
  const longNote = ('This is a long footnote body that goes on at considerable length. '
    .repeat(44)).slice(0, 2800);
  const eighteenLines = Array.from({ length: 18 },
    (_, i) => `Paragraph ${i} is one line.`).join('\n\n');

  test('a long footnote BODY is measured, not costed as two lines', () => {
    const tex = pandocToLatex(
      `::: info\n\n${eighteenLines}\n\nAnd a trailing sentence with a footnote.[^big]\n\n:::\n\n[^big]: ${longNote}\n`);
    expect(tex).toMatch(/\\footnote\{/);         // the footnote really is inside the box
    expect(tex).not.toMatch(/breakable=false/);
  });

  test('a long INLINE footnote body is measured too', () => {
    // `^[...]` reaches the Note handler by a different route from a `[^1]` reference, and was
    // under-measured identically.
    const tex = pandocToLatex(`::: info\n\n${eighteenLines}\n\nAnd inline.^[${longNote}]\n\n:::\n`);
    expect(tex).toMatch(/\\footnote\{/);
    expect(tex).not.toMatch(/breakable=false/);
  });

  test('a raw inline makes the box unmeasurable, like an image', () => {
    // Same mechanism as the Note: stringify() returns "" for a RawInline, so this measured as
    // two short paragraphs and was pinned. Its real height is 20cm.
    const tex = pandocToLatex(
      '::: info\n\nOne short line.\n\n`\\vspace{20cm}`{=latex}\n\nAnother short line.\n\n:::\n');
    expect(tex).toMatch(/\\vspace\{20cm\}/);    // the raw LaTeX really is inside the box
    expect(tex).not.toMatch(/breakable=false/);
  });
});

// I-1. The FIT constants describe ONE page geometry (6x9, 0.75in top and bottom, 11pt at
// linestretch 1.2). book-builder is shared and config/pandoc-defaults-print.yaml names the
// filters but NOT the template -- that comes from the consuming book's book.config.js. So a
// book using these print defaults with its own A5 or 10pt template would have had its boxes
// pinned against this book's 542pt text block, and the failure mode is not a warning but a
// non-terminating xelatex. Pinning is therefore opt-in, declared by the template.
maybe('callout filter: pinning is opt-in, declared by the template', () => {
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calloutgate-')); });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('a callout that fits is NOT pinned when no budget is declared', () => {
    // The default for every consuming book: correct, slightly more split boxes, no hangs.
    expect(pandocToLatex(codeCallout(16), [])).not.toMatch(/breakable=false/);
    expect(pandocToLatex(promptRefCallout(2), [])).not.toMatch(/breakable=false/);
  });

  test('declaring the budget is what turns pinning on', () => {
    expect(pandocToLatex(codeCallout(16), [PIN_BUDGET_META])).toMatch(/breakable=false/);
  });

  test('a budget that is not a usable number is ignored, not honoured', () => {
    for (const bad of ['', 'yes', '0', '-100', '1000000']) {
      expect(pandocToLatex(codeCallout(16), [`--metadata=callout-pin-budget:${bad}`]))
        .not.toMatch(/breakable=false/);
    }
  });

  test('book-print.latex declares exactly the budget the filter was calibrated for', () => {
    // Two numbers that must not drift: the template's \calloutPinBudget, and
    // fraction x text_block in the filter's FIT table. If the trim changes, BOTH move, and
    // so do the per-line constants -- re-measure with fixtures/fit-probe.tex.
    const declared = readCalloutPinBudget(
      fs.readFileSync(path.join(TEMPLATES, 'book-print.latex'), 'utf8'));
    const lua = fs.readFileSync(path.join(FILTERS, 'callout-filter-print.lua'), 'utf8');
    const textBlock = Number(/text_block\s*=\s*([\d.]+)/.exec(lua)[1]);
    const fraction = Number(/fraction\s*=\s*([\d.]+)/.exec(lua)[1]);
    expect(declared).toBeCloseTo(fraction * textBlock, 1);
  });

  test('the digital template declares no budget', () => {
    // The digital PDF uses callout-filter-digital.lua, which does not pin at all. A budget
    // there would be meaningless, and a copied one would be the exact mistake I-1 is about.
    expect(readCalloutPinBudget(
      fs.readFileSync(path.join(TEMPLATES, 'book-digital.latex'), 'utf8'))).toBeNull();
  });
});

// THE FIT CONSTANTS, THE PROBE AND THE WRITE-UP MUST STAY IN STEP. There are three copies of
// every one of these numbers -- the filter's FIT table, the reference run recorded in
// fixtures/fit-probe.md, and the derivation table in memory-bank/systemPatterns.md -- and the
// numbers are the inputs to a decision whose wrong answer is a build that never terminates.
// title_line was 18.00 in the filter against 19.65 in the probe for a whole round, recorded as
// a finding and shipped anyway; these tests are what makes that visible next time.
maybe('callout filter: the FIT constants agree with the committed probe', () => {
  const LUA = fs.readFileSync(path.join(FILTERS, 'callout-filter-print.lua'), 'utf8');
  const PROBE = fs.readFileSync(path.join(__dirname, 'fixtures', 'fit-probe.md'), 'utf8');
  // ANCHORED TO THE START OF A LINE, which is where a FIT table entry is. Unanchored, the
  // first match for `text_line = ` is inside title_line's own comment, which quotes the
  // probe's arithmetic ("- text_line = 35.97 - 16.32"), and the test silently measures the
  // documentation instead of the constant.
  const fit = (name) => Number(
    new RegExp(`^\\s*${name}\\s*=\\s*([\\d.]+)`, 'm').exec(LUA)[1]);

  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calloutfit-const-')); });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('title_line holds the probe\'s measured value, not a rounded guess', () => {
    // 19.65 = (title-83 - title-11) - text_line, the LARGER of the two measured steps. The
    // 2->3 step is only 13.03 because the attached boxed title is laid over the box's own top
    // padding; using the larger figure for every line over-estimates a 3-line title, which is
    // the direction that leaves a box breakable rather than pinning one that does not fit.
    expect(fit('title_line')).toBeCloseTo(19.65, 2);
    expect(PROBE).toContain('19.65');
    expect(PROBE).toContain('13.03');
  });

  test('every FIT constant the probe measures is the value the probe recorded', () => {
    for (const [name, want] of Object.entries({
      text_block: 542.03, text_line: 16.32, code_line: 14.40, code_pad: 6.30,
      note_line: 11.00, em: 11.00, box: 34.00, title_line: 19.65,
      // CORRECTED FROM 10.00 on 2026-11-02. The probe has recorded 10.19 all along and the
      // filter rounded it down, which is a constant running LOW -- the direction that pins a
      // box that does not fit. 0.19pt once per footnoted box moved nothing in this book, and
      // "it is only a fifth of a point" is not a reason for the table and the probe to
      // disagree.
      note_base: 10.19,
    })) {
      expect(fit(name)).toBeCloseTo(want, 2);
    }
  });

  // THE CONTINUATION-LINE INDENT. minted/fvextra's `breakautoindent` is on by default and
  // `\setminted` in book-print.latex does not turn it off, so a wrapped code line's
  // continuations are indented under the ORIGINAL line's leading whitespace and hold fewer
  // than code_chars characters. Estimating them at the full measure under-counted, and
  // under-counting is what pins a box that does not fit.
  //
  // This was the largest estimator drift in the book: the pre-flight measured a code callout
  // at 383.82pt against its 371.50pt estimate, +12.32pt, which is one rendered code line of
  // exactly this shape. Like title_line, the term is a line of Lua that a refactor could drop
  // in silence -- nothing in the rendered book would change until a box near the budget was
  // pinned that should not have been.
  test('an indented code line that wraps costs the extra rendered line', () => {
    const est = (line) => {
      const tex = pandocToLatex(`::: code\n\n\`\`\`java\n${line}\n\`\`\`\n\n:::\n`);
      return Number(/%%CALLOUTFIT .* est=([\d.]+)/.exec(tex)[1]);
    };
    const chars = fit('code_chars');   // 48: what the FIRST rendered line holds
    const indent = 8;
    const width = 96;                  // two full measures: 2 lines flat, 3 lines indented
    const flat = 'x'.repeat(width);
    const nested = ' '.repeat(indent) + 'x'.repeat(width - indent);
    // The fixture has to exercise the term: same character count, different wrap.
    expect(flat.length).toBe(nested.length);
    expect(Math.ceil(width / chars)).toBe(2);
    expect(1 + Math.ceil((width - chars) / (chars - indent))).toBe(3);
    // ...so the indented line costs exactly one more rendered line than the flat one.
    expect(est(nested) - est(flat)).toBeCloseTo(fit('code_line'), 2);
  });

  // The other half of the same property: an indent must not be charged to a line that never
  // wraps. Over-estimating is the safe direction but it still unpins boxes, and the fix is
  // meant to cost the book nothing it does not have to.
  test('an indented code line that FITS the measure still costs one rendered line', () => {
    const est = (line) => {
      const tex = pandocToLatex(`::: code\n\n\`\`\`java\n${line}\n\`\`\`\n\n:::\n`);
      return Number(/%%CALLOUTFIT .* est=([\d.]+)/.exec(tex)[1]);
    };
    const chars = fit('code_chars');
    expect(est(' '.repeat(16) + 'x'.repeat(chars - 16))).toBeCloseTo(est('x'.repeat(chars)), 2);
  });

  // The estimator must actually SPEND title_line on each line a boxed title wraps to. The
  // term is one line of Lua and a refactor could drop it silently: nothing in the rendered
  // book would change until a box near the budget was pinned that should not have been.
  test('a wrapped boxed title costs title_line per extra line, on top of the Link: line', () => {
    const est = (title) => {
      const tex = pandocToLatex(
        `::: {.promptref title="${title}" url="https://constellize.com/p/x"}\nOne body line.\n:::\n`);
      return Number(/%%CALLOUTFIT .* est=([\d.]+)/.exec(tex)[1]);
    };
    const titleChars = fit('title_chars');
    const textChars = fit('text_chars');
    const short = 'x'.repeat(40);                 // 1 title line, 1 Link: line
    const long = 'y'.repeat(84);                  // 2 title lines, 2 Link: lines
    const titleLines = (t) => Math.ceil(t.length / titleChars);
    const linkLines = (t) => Math.ceil((`Link: ${t}`).length / textChars);
    const expected =
      fit('title_line') * (titleLines(long) - titleLines(short)) +
      fit('text_line') * (linkLines(long) - linkLines(short));
    expect(titleLines(long) - titleLines(short)).toBe(1); // the fixture exercises the term
    expect(est(long) - est(short)).toBeCloseTo(expected, 2);
  });
});
