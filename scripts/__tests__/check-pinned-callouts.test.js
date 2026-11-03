// The pre-flight fit check (scripts/check-pinned-callouts.js).
//
// WHAT IS BEING TESTED, AND WHY IT IS WORTH TESTING. callout-filter-print.lua pins a callout
// (`breakable=false`) whose height it ESTIMATES will fit the page. A pinned box that does not
// fit does not warn, does not error and does not produce an `Overfull \vbox` -- xelatex ships
// empty pages forever, and a build that never finishes writes no log, so no other check in
// this system can see the fault at all. The pre-flight check typesets each pinned box ALONE
// in a \vbox, measures it, and fails the build naming the box.
//
// So the case that matters is the negative one: a pinned box that does NOT fit must be
// REPORTED, not merely measured. That case is constructed below out of the real template by
// flipping a long box's `breakable` to `breakable=false` -- which is precisely the latent
// hang, and is safe to run because the check never ships a box to a page (see
// `does not ship any box to a page`).
//
// The parsing tests need nothing but node. The measuring tests need pandoc, xelatex and the
// fonts the print template names by relative path, and skip without them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const TEMPLATES = path.resolve(__dirname, '..', '..', 'templates');
const FILTERS = path.join(TEMPLATES, 'filters');
const BOOK_ROOT = path.resolve(__dirname, '..', '..', '..');

const {
  checkPinnedCallouts,
  splitPreamble,
  extractEnvironment,
  parseProvenance,
  findCallouts,
  buildProbe,
  excerpt,
  jsonArtifact,
} = require(path.join(SCRIPTS, 'check-pinned-callouts.js'));
const { readCalloutPinBudget } = require('../lib/callout-pin-budget.js');

const ENV = {
  ...process.env,
  PATH: [process.env.PATH, '/Library/TeX/texbin', '/usr/local/texlive/2025/bin/universal-darwin',
    path.join(BOOK_ROOT, 'book-builder', '.venv', 'bin')].filter(Boolean).join(':'),
};
function have(cmd) {
  try { execFileSync('which', [cmd], { env: ENV, stdio: 'ignore' }); return true; } catch { return false; }
}

const PIN_BUDGET = readCalloutPinBudget(
  fs.readFileSync(path.join(TEMPLATES, 'book-print.latex'), 'utf8'));

// --------------------------------------------------------------------------------------
// Parsing: no external tools
// --------------------------------------------------------------------------------------

describe('reading the emitted .tex', () => {
  test('the preamble is everything before \\begin{document}', () => {
    const tex = 'A\n\\usepackage{x}\n\\begin{document}\nB\n\\end{document}\n';
    expect(splitPreamble(tex)).toBe('A\n\\usepackage{x}\n');
  });

  test('a .tex with no \\begin{document} is NOT CHECKED, never a pass', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinfit-test-'));
    const f = path.join(tmp, 'fragment.tex');
    fs.writeFileSync(f, '%%CALLOUTFIT type=info pinned=1 est=50 budget=433.6 title=Info\n');
    const r = checkPinnedCallouts({ tex: f, quiet: true });
    expect(r.status).toBe('not-checked');
    expect(r.status).not.toBe('pass');
  });

  test('a missing .tex is NOT CHECKED, never a pass', () => {
    const r = checkPinnedCallouts({ tex: path.join(os.tmpdir(), 'no-such-file.tex'), quiet: true });
    expect(r.status).toBe('not-checked');
  });

  test('a title containing spaces and = survives the provenance line', () => {
    const p = parseProvenance(
      '%%CALLOUTFIT type=promptref pinned=1 est=419.00 budget=433.6 title=Set X = Y, And Z');
    expect(p.type).toBe('promptref');
    expect(p.pinned).toBe('1');
    expect(p.est).toBe('419.00');
    expect(p.title).toBe('Set X = Y, And Z');
  });

  test('an unmeasurable box carries est=? and is never pinned', () => {
    const p = parseProvenance('%%CALLOUTFIT type=conversation pinned=0 est=? budget=433.6 title=Conversation');
    expect(p.est).toBe('?');
    expect(p.pinned).toBe('0');
  });

  // A conversation callout's body is a stack of tcolorboxes. "The next \end{tcolorbox}"
  // would stop inside it and hand a truncated, unbalanced box to xelatex.
  test('a nested tcolorbox does not end the outer one', () => {
    const tex = [
      '\\begin{tcolorbox}[breakable]',
      '\\begin{tcolorbox}[boxrule=0.5pt]',
      'Human: hi',
      '\\end{tcolorbox}',
      'tail',
      '\\end{tcolorbox}',
      'AFTER',
    ].join('\n');
    const env = extractEnvironment(tex, 0);
    expect(env.source.endsWith('\\end{tcolorbox}')).toBe(true);
    expect(env.source).toContain('tail');
    expect(tex.slice(env.end)).toBe('\nAFTER');
  });

  test('an unterminated tcolorbox is reported as unextractable, not guessed at', () => {
    expect(extractEnvironment('\\begin{tcolorbox}[breakable]\nno end\n', 0)).toBeNull();
  });

  test('pinned is read from the BOX OPTIONS, and the comment only says what it was pinned against', () => {
    const tex = [
      '\\begin{document}',
      '%%CALLOUTFIT type=code pinned=1 est=308.70 budget=433.6 title=Code',
      '\\begin{tcolorbox}[',
      '  colback=violet!5!white,',
      '  breakable=false,',
      '  enhanced',
      ']',
      'x',
      '\\end{tcolorbox}',
      '%%CALLOUTFIT type=info pinned=0 est=700.00 budget=433.6 title=Info',
      '\\begin{tcolorbox}[',
      '  breakable,',
      '  enhanced',
      ']',
      'y',
      '\\end{tcolorbox}',
    ].join('\n');
    const found = findCallouts(tex);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ type: 'code', estimate: 308.7, optionsPinned: true, declaredPinned: true });
    expect(found[1]).toMatchObject({ type: 'info', estimate: 700, optionsPinned: false, declaredPinned: false });
  });

  // `breakable=false` must not be matched inside a longer key, and `breakable` on its own
  // must not be read as pinned.
  test('breakable and breakable=false are told apart', () => {
    const mk = (opt) => `\\begin{document}\n%%CALLOUTFIT type=info pinned=0 est=1 budget=2 title=I\n\\begin{tcolorbox}[\n  ${opt},\n  enhanced\n]\nx\n\\end{tcolorbox}\n`;
    expect(findCallouts(mk('breakable'))[0].optionsPinned).toBe(false);
    expect(findCallouts(mk('breakable=false'))[0].optionsPinned).toBe(true);
  });

  test('a comment that disagrees with the box options FAILS rather than picking a side', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinfit-test-'));
    const f = path.join(tmp, 'skew.tex');
    fs.writeFileSync(f, [
      '\\documentclass{book}',
      '\\begin{document}',
      '%%CALLOUTFIT type=info pinned=1 est=50.00 budget=433.6 title=Info',
      '\\begin{tcolorbox}[',
      '  breakable,',
      '  enhanced',
      ']',
      'x',
      '\\end{tcolorbox}',
      '\\end{document}',
    ].join('\n'));
    const r = checkPinnedCallouts({ tex: f, quiet: true });
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/does not parse/);
  });

  test('no pinned boxes is NOT CHECKED, not a green pass over nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinfit-test-'));
    const f = path.join(tmp, 'none.tex');
    fs.writeFileSync(f, [
      '\\documentclass{book}',
      '\\begin{document}',
      '%%CALLOUTFIT type=info pinned=0 est=700.00 budget=433.6 title=Info',
      '\\begin{tcolorbox}[',
      '  breakable,',
      '  enhanced',
      ']',
      'x',
      '\\end{tcolorbox}',
      '\\end{document}',
    ].join('\n'));
    const r = checkPinnedCallouts({ tex: f, quiet: true });
    expect(r.status).toBe('not-checked');
    expect(r.reason).toMatch(/no pinned callouts/);
  });

  // --------------------------------------------------------------------------------------
  // The JSON artifact
  //
  // `json:` used to be honoured only by main(), so every LIBRARY caller's artifact was
  // silently dropped -- and build-book.js is a library caller, which is why a real print
  // build never produced build/intermediate/preflight-pinfit.json. The check reported a
  // correct verdict and left no measurements behind it, which is the shape of all three
  // "reports zero because it measured nothing" bugs this round turned up.
  // --------------------------------------------------------------------------------------

  test('json: is honoured by the LIBRARY entry point, not only by the CLI', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinfit-test-'));
    const out = path.join(tmp, 'nested', 'preflight-pinfit.json');
    const r = checkPinnedCallouts({ tex: path.join(tmp, 'absent.tex'), json: out, quiet: true });
    expect(r.status).toBe('not-checked');
    // Written even on a not-checked path: the artifact records WHY nothing was measured.
    expect(fs.existsSync(out)).toBe(true);
    const art = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(art.status).toBe('not-checked');
    expect(art.reason).toMatch(/no such \.tex/);
    expect(art.measured).toEqual([]);
  });

  test('the artifact carries the per-box numbers, not just a verdict', () => {
    // jsonArtifact() is asserted directly as well as through a real measurement below, so
    // the shape is pinned even where xelatex is unavailable.
    const art = jsonArtifact({
      status: 'fail',
      usable: 542.03,
      tolerance: 2,
      pinnedCount: 2,
      callouts: [{}, {}, {}],
      measured: [
        { index: 1, type: 'code', title: 'A', estimate: 371.5, measured: 383.82, fits: true, driftBy: 12.32 },
        { index: 2, type: 'info', title: 'B', estimate: 100, measured: 600, fits: false, driftBy: 500 },
      ],
      failures: [{ index: 2, type: 'info', title: 'B', measured: 600, overBy: 57.97 }],
      unmeasured: [{ index: 3, type: 'rule', title: 'C', estimate: 50 }],
      drift: [{ index: 1, type: 'code', title: 'A', estimate: 371.5, measured: 383.82, driftBy: 12.32 }],
    });
    // The measurements, per box, with what each was pinned against.
    expect(art.measured).toHaveLength(2);
    expect(art.measured[0]).toEqual({
      index: 1, type: 'code', title: 'A', estimate: 371.5, measured: 383.82, fits: true, driftBy: 12.32,
    });
    expect(art.measured[1].measured).toBe(600);
    expect(art.failures[0].overBy).toBeCloseTo(57.97, 2);
    expect(art.drift[0].driftBy).toBeCloseTo(12.32, 2);
    // A box that produced NO height is its own list. Without it a fail caused only by an
    // unmeasured box serialises as `failures: []` and reads as clean.
    expect(art.unmeasured).toEqual([{ index: 3, type: 'rule', title: 'C', estimate: 50 }]);
    expect(art.pinnedCount).toBe(2);
    expect(art.calloutCount).toBe(3);
  });

  // THE LOAD-BEARING SAFETY PROPERTY. Putting an unbreakable box ON a page is the operation
  // that hangs xelatex. The probe measures inside a \vbox and throws the box away; if it ever
  // shipped one, the check would reproduce the fault it exists to prevent.
  test('does not ship any box to a page', () => {
    const probe = buildProbe('\\documentclass{book}\n', [
      { index: 1, source: '\\begin{tcolorbox}[breakable=false]\nx\n\\end{tcolorbox}' },
    ]);
    expect(probe).toContain('\\setbox0=\\vbox{');
    expect(probe).toContain('\\the\\dimexpr\\ht0+\\dp0\\relax');
    // Every one of these would put the measured box on the page.
    expect(probe).not.toMatch(/\\box0(?!\+)/);
    expect(probe).not.toContain('\\unvbox');
    expect(probe).not.toContain('\\copy0');
    // ...and the box register is cleared after each measurement.
    expect(probe).toContain('\\setbox0=\\vbox{}');
  });

  test('an excerpt is plain enough to grep the manuscript for', () => {
    const src = [
      '\\begin{tcolorbox}[',
      '  colback=blue!5!white,',
      '  breakable=false',
      ']',
      '',
      'Rule: Memory bank updates are not \\textbf{optional}.',
      '\\end{tcolorbox}',
    ].join('\n');
    const e = excerpt(src);
    expect(e).toContain('Rule: Memory bank updates are not');
    expect(e).not.toContain('colback');
    expect(e).not.toContain('textbf');
  });
});

// --------------------------------------------------------------------------------------
// Measuring: needs pandoc, xelatex and the template's fonts
// --------------------------------------------------------------------------------------

const FONTS = path.join(BOOK_ROOT, 'book-builder', 'fonts');
const CAN_MEASURE = have('pandoc') && have('xelatex') && fs.existsSync(FONTS);
if (!CAN_MEASURE) {
  console.warn('check-pinned-callouts measuring tests SKIPPED: need pandoc, xelatex and ' +
    `${FONTS} reachable from the consuming book's root`);
}
const measuring = CAN_MEASURE ? describe : describe.skip;

const FROM = 'markdown+fenced_divs+raw_attribute+footnotes+line_blocks+escaped_line_breaks+link_attributes';

/** A real print-template .tex built from `md`, with the real preamble and real pin decisions. */
function printTex(md, tmp) {
  const src = path.join(tmp, 'in.md');
  fs.writeFileSync(src, md);
  const out = path.join(tmp, 'in.tex');
  execFileSync('pandoc', [
    src, '-f', FROM, '-t', 'latex', '--standalone',
    `--template=${path.join(TEMPLATES, 'book-print.latex')}`,
    `--metadata=callout-pin-budget:${PIN_BUDGET}`,
    '--metadata=title=fit',
    `--lua-filter=${path.join(FILTERS, 'minted-filter.lua')}`,
    `--lua-filter=${path.join(FILTERS, 'callout-filter-print.lua')}`,
    '-o', out,
  ], { env: ENV, cwd: BOOK_ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  return out;
}

const codeCallout = (n) => `::: code\n\n\`\`\`json\n{\n${
  Array.from({ length: n }, (_, i) => `  "k${i}": "v${i}",`).join('\n')}\n}\n\`\`\`\n\n:::\n`;

measuring('measuring real boxes', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinfit-measure-')); });

  test('a short pinned box is measured and passes', () => {
    const tex = printTex(`${codeCallout(8)}\n`, tmp);
    // Asserted through findCallouts, not on the whole file: book-print.latex's own PREAMBLE
    // COMMENTS contain the string "breakable=false" (they explain the feature), so a plain
    // grep over a standalone .tex matches the documentation rather than a box.
    expect(findCallouts(fs.readFileSync(tex, 'utf8')).map((c) => c.optionsPinned)).toEqual([true]);
    const r = checkPinnedCallouts({
      tex, quiet: true, cwd: BOOK_ROOT, env: ENV, workdir: path.join(tmp, 'wd'),
    });
    expect(r.status).toBe('pass');
    expect(r.pinnedCount).toBe(1);
    // A real measurement, not a default: a one-box code callout is tens of points tall.
    expect(r.measured[0].measured).toBeGreaterThan(40);
    expect(r.measured[0].measured).toBeLessThan(r.usable);
    // ...and the estimator was not short.
    expect(r.measured[0].driftBy).toBeLessThanOrEqual(r.tolerance);
  }, 300000);

  // The artifact a real pre-flight leaves behind. This is the end-to-end half of the two
  // json: tests above: the file must hold the heights TeX actually measured, so that a
  // later reader has the numbers and not only the pass.
  test('a real measurement is written to the json: path, heights and all', () => {
    const tex = printTex(`${codeCallout(8)}\n`, tmp);
    const out = path.join(tmp, 'artifact', 'preflight-pinfit.json');
    const r = checkPinnedCallouts({
      tex, quiet: true, cwd: BOOK_ROOT, env: ENV, workdir: path.join(tmp, 'wd5'), json: out,
    });
    expect(r.status).toBe('pass');
    expect(fs.existsSync(out)).toBe(true);
    const art = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(art.status).toBe('pass');
    expect(art.pinnedCount).toBe(1);
    expect(art.measured).toHaveLength(1);
    // The MEASUREMENT, not a verdict: a real height, agreeing with the returned result.
    expect(art.measured[0].measured).toBeCloseTo(r.measured[0].measured, 2);
    expect(art.measured[0].measured).toBeGreaterThan(40);
    expect(art.measured[0].estimate).toBeCloseTo(r.measured[0].estimate, 2);
    expect(art.measured[0].driftBy).toBeCloseTo(r.measured[0].driftBy, 2);
    expect(art.measured[0].fits).toBe(true);
    expect(art.usable).toBeCloseTo(r.usable, 2);
  }, 300000);

  // THE CASE THE CHECK EXISTS FOR. A box the filter correctly left breakable is pinned by
  // hand -- the shape of every estimator bug found so far -- and must be caught and named.
  test('a pinned box taller than the page FAILS, and the failure names it', () => {
    const texPath = printTex(`${codeCallout(120)}\n`, tmp);
    const original = fs.readFileSync(texPath, 'utf8');
    // The filter is right about this one: 120 lines of JSON is far too tall to pin.
    const before = findCallouts(original);
    expect(before).toHaveLength(1);
    expect(before[0].optionsPinned).toBe(false);
    // Pin it by hand, editing ONLY the box's own option list. The preamble has `breakable,`
    // lines of its own in \newtcolorbox definitions, and comments mentioning
    // "breakable=false", so neither string can be rewritten document-wide.
    const box = before[0].source;
    const pinnedBox = box.replace(/^(\s*)breakable,$/m, '$1breakable=false,');
    expect(pinnedBox).not.toBe(box);
    const latent = original
      // Matched by KEY, not by the whole line: the provenance gained an `idx=` field when
      // measured heights started travelling back to the filter, and a fixture pinned to the
      // exact key order silently stops matching and tests nothing.
      .replace(/(%%CALLOUTFIT[^\n]*?)pinned=0/, '$1pinned=1')
      .replace(box, pinnedBox);
    expect(findCallouts(latent)[0].optionsPinned).toBe(true);
    const f = path.join(tmp, 'latent.tex');
    fs.writeFileSync(f, latent);

    const r = checkPinnedCallouts({
      tex: f, quiet: true, cwd: BOOK_ROOT, env: ENV, workdir: path.join(tmp, 'wd2'),
    });
    expect(r.status).toBe('fail');
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].measured).toBeGreaterThan(r.usable);
    expect(r.failures[0].overBy).toBeGreaterThan(0);
    // Named well enough to find in the sources.
    expect(r.failures[0].type).toBe('code');
    expect(excerpt(r.failures[0].source)).toContain('k0');
  }, 300000);

  // Found the hard way: a pandoc template variable written inside a LaTeX comment in
  // book-print.latex pasted the header-includes block into the preamble. Under nonstopmode
  // that errored and carried on, so the probe measured 123 boxes and reported them all
  // fitting -- against a preamble the real build (`-halt-on-error`) refused outright.
  test('a TeX error in the probe is NOT CHECKED, not a pass over the wrong preamble', () => {
    const texPath = printTex(`${codeCallout(8)}\n`, tmp);
    const broken = fs.readFileSync(texPath, 'utf8')
      .replace(/^[ \t]*\\begin\{document\}/m, '\\@ifpackageloaded{subcaption}{}{}\n\\begin{document}');
    const f = path.join(tmp, 'broken-preamble.tex');
    fs.writeFileSync(f, broken);
    const r = checkPinnedCallouts({
      tex: f, quiet: true, cwd: BOOK_ROOT, env: ENV, workdir: path.join(tmp, 'wd4'),
    });
    expect(r.status).toBe('not-checked');
    expect(r.status).not.toBe('pass');
    expect(r.reason).toMatch(/TeX error/);
  }, 300000);

  // Estimator drift: the box still fits, but the estimate it was pinned on was LOW. That is
  // a FIT-constant bug and the direction that ends in a hang, so it is reported even though
  // the build is allowed to continue.
  test('an estimate that runs low is reported even when the box fits', () => {
    const texPath = printTex(`${codeCallout(8)}\n`, tmp);
    const lowered = fs.readFileSync(texPath, 'utf8')
      // Keyed on `est=` alone, for the same reason as the pinned=0 replacement above.
      .replace(/^(%%CALLOUTFIT[^\n]*?est=)[0-9.]+/m, '$11.00');
    const f = path.join(tmp, 'lowered.tex');
    fs.writeFileSync(f, lowered);
    const r = checkPinnedCallouts({
      tex: f, quiet: true, cwd: BOOK_ROOT, env: ENV, workdir: path.join(tmp, 'wd3'),
    });
    expect(r.status).toBe('pass');            // it fits: not a build failure
    expect(r.drift).toHaveLength(1);          // but it is reported
    expect(r.drift[0].driftBy).toBeGreaterThan(r.tolerance);
  }, 300000);
});
