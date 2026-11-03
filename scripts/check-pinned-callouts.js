#!/usr/bin/env node
/**
 * PRE-FLIGHT FIT CHECK FOR PINNED CALLOUTS.
 *
 * Run between pandoc and xelatex. Typesets every `breakable=false` tcolorbox ON ITS OWN,
 * in a minimal document built from the book's REAL preamble, and measures its height with
 * `\setbox0=\vbox{...}` / `\the\dimexpr\ht0+\dp0`. A box that measures taller than the text
 * block fails the build, naming the box.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE ONE PLACE A HARD FAILURE IS CORRECT
 * ---------------------------------------------------------------------
 * `templates/filters/callout-filter-print.lua` sets `breakable=false` on a callout it
 * ESTIMATES will fit a page, so the box moves whole instead of splitting and shedding an
 * orphaned tail. A pinned box that does NOT fit does not warn, does not error and does not
 * produce an `Overfull \vbox`: xelatex spins forever shipping empty pages. Measured at the
 * 6x9 trim with `book-print.latex`, a pinned code callout of 35 rendered lines typesets and
 * one of 36 never terminates. `-halt-on-error` cannot rescue it, and neither the
 * `Overfull \vbox` check nor `detect-typeset-faults.py` can see it, because a build that
 * never finishes writes no log and no PDF.
 *
 * So the alternative to failing is not "a slightly worse book", it is an infinite build. The
 * rest of this build system warns and carries on; this check stops.
 *
 * WHY MEASURE RATHER THAN RE-CHECK THE ESTIMATE
 * --------------------------------------------
 * Checking a pinned box against the estimator is circular -- the estimator is what decided
 * to pin it. Three separate breaches of its "refuse to pin what you cannot measure" contract
 * have been found so far (a LineBlock that bypassed the Image guard, a LineBreak flattened
 * to a space, a footnote body costed as a flat 32pt), and each was found by reading the code,
 * not by anything the build measured. This runs TeX over the real box instead, so it answers
 * the question the estimator was guessing at.
 *
 * IT DELIBERATELY DOES NOT SHIP THE BOXES TO A PAGE. Each box is measured inside a `\vbox`
 * and then discarded. Putting an unbreakable box ON a page is precisely the operation that
 * hangs, so a check that rendered them would reproduce the fault it is there to prevent.
 * Measuring inside a `\vbox` of unbounded height does no page breaking at all.
 *
 * TWO xelatex PASSES ARE REQUIRED. minted writes its highlighted content to an auxiliary
 * file on the first pass and reads it back on the second, so on a single pass every code box
 * measures as though it were empty -- a believable number and a wrong one.
 *
 * THE SECOND THING IT REPORTS: ESTIMATOR DRIFT
 * -------------------------------------------
 * The filter writes its own estimate into the .tex as a `%%CALLOUTFIT` comment. Any box whose
 * MEASURED height exceeds that estimate by more than the tolerance is reported even when it
 * still fits the page, because that is a `FIT`-constant bug, and an unnoticed one is how a
 * box that fits today becomes a hang after a sentence is added to it. Drift is reported, not
 * fatal: the estimate running low by a point is a defect to fix, not a reason to refuse to
 * build, and the fit check above is what stands between it and the cliff.
 *
 * DEGRADING
 * ---------
 * No TeX, or no pinned boxes to check, exits 0 and says which. It never reports a clean
 * result for something it did not measure -- the exit text distinguishes "0 pinned boxes
 * failed" from "not checked".
 *
 * Usage:
 *   node check-pinned-callouts.js <book.tex> [--tolerance 2] [--workdir DIR] [--json OUT]
 *                                           [--timeout SECONDS] [--quiet]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Estimator-drift tolerance, in TeX points. Not slack: the estimator is built to run HIGH
// (FIT.box holds 34.00 against a measured 31.71, FIT.em 11.00 against 10.95, and the
// characters-per-line constants are all held below the width at which a line really wraps),
// so a measured height within a couple of points of the estimate already means a constant is
// wrong. 2pt is under one eighth of a body line (16.32pt), which is small enough to catch a
// real error and large enough not to fire on TeX's own dimension rounding.
const DEFAULT_TOLERANCE_PT = 2.0;

// Per-pass timeout for THIS check's own xelatex runs. It typesets boxes, not 267 pages, and
// it cannot hang on an unbreakable box (nothing is shipped to a page), so this is only a
// guard against a pathological preamble. The book's own build has its own, larger, timeout.
const DEFAULT_PROBE_TIMEOUT_S = 300;

const TEXLIVE_PATHS = [
  '/Library/TeX/texbin',
  '/usr/local/texlive/2025/bin/universal-darwin',
  '/usr/local/texlive/2024/bin/universal-darwin',
  '/usr/local/texlive/2023/bin/universal-darwin',
];

// `base` lets a caller hand in an already-extended environment. build-book.js does: the
// print build puts book-builder/.venv/bin on PATH for pygmentize, which minted shells out to,
// and without it every code box in the probe fails to typeset rather than measuring short.
function texEnv(base) {
  const env = base || process.env;
  return { ...env, PATH: [env.PATH, ...TEXLIVE_PATHS].filter(Boolean).join(':') };
}

function haveXelatex(env) {
  const r = spawnSync('xelatex', ['--version'], { env, stdio: 'ignore' });
  return !r.error && r.status === 0;
}

// ---------------------------------------------------------------------------------------
// Parsing the emitted .tex
// ---------------------------------------------------------------------------------------

/** The preamble: everything before the first `\begin{document}` that starts a line. */
function splitPreamble(tex) {
  const m = /^[ \t]*\\begin\{document\}/m.exec(tex);
  if (!m) return null;
  return tex.slice(0, m.index);
}

/**
 * Source of the tcolorbox environment starting at `from`, by DEPTH COUNTING.
 *
 * A conversation callout's body is itself a stack of tcolorboxes, so "the next
 * \end{tcolorbox}" is not the right one in general. Conversation boxes are never pinned,
 * but counting depth costs nothing and means this cannot be wrong for a box kind added later.
 */
function extractEnvironment(tex, from) {
  const BEGIN = '\\begin{tcolorbox}';
  const END = '\\end{tcolorbox}';
  const start = tex.indexOf(BEGIN, from);
  if (start === -1) return null;
  let depth = 0;
  let i = start;
  while (i < tex.length) {
    const nb = tex.indexOf(BEGIN, i);
    const ne = tex.indexOf(END, i);
    if (ne === -1) return null; // unterminated: the .tex is not what we think it is
    if (nb !== -1 && nb < ne) {
      depth += 1;
      i = nb + BEGIN.length;
    } else {
      depth -= 1;
      i = ne + END.length;
      if (depth === 0) return { start, end: i, source: tex.slice(start, i) };
    }
  }
  return null;
}

/** Parse one `%%CALLOUTFIT k=v ...` line. `title=` runs to end of line, so it comes last. */
function parseProvenance(line) {
  const out = {};
  const m = /^%%CALLOUTFIT\s+(.*)$/.exec(line);
  if (!m) return null;
  const rest = m[1];
  const titleAt = rest.indexOf('title=');
  const head = titleAt === -1 ? rest : rest.slice(0, titleAt);
  out.title = titleAt === -1 ? '' : rest.slice(titleAt + 'title='.length).trim();
  for (const pair of head.trim().split(/\s+/).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * Every callout in the document, in order, with its provenance and (for the pinned ones)
 * its LaTeX source.
 */
function findCallouts(tex) {
  const callouts = [];
  const re = /^%%CALLOUTFIT .*$/gm;
  let m;
  while ((m = re.exec(tex)) !== null) {
    const prov = parseProvenance(m[0]);
    if (!prov) continue;
    const env = extractEnvironment(tex, m.index + m[0].length);
    const declaredPinned = prov.pinned === '1';
    // The box's own option list is the authority on whether it is pinned; the provenance
    // comment is the authority on what it was pinned AGAINST. If they disagree, something
    // between the filter and here rewrote the .tex and nothing downstream can be trusted.
    const optionsPinned = env ? /(^|[\s,[])breakable=false(\s*[,\]]|$)/m.test(env.source) : null;
    callouts.push({
      index: callouts.length + 1,
      type: prov.type || '?',
      title: prov.title || '',
      estimate: prov.est === '?' || prov.est === undefined ? null : Number(prov.est),
      budget: prov.budget === 'none' ? null : Number(prov.budget),
      declaredPinned,
      optionsPinned,
      source: env ? env.source : null,
      texOffset: m.index,
    });
  }
  return callouts;
}

/** A few words of the box's text, enough to find it in the manuscript. */
function excerpt(source, max = 110) {
  const body = source
    .replace(/^\\begin\{tcolorbox\}\[[\s\S]*?\n\]/, '') // the option list
    .replace(/\\end\{tcolorbox\}$/, '')
    .replace(/\\begin\{[^}]*\}(\[[^\]]*\])?|\\end\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[{}\\$&~^_%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.length > max ? `${body.slice(0, max)}...` : body;
}

// ---------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------

/**
 * Build the measuring document: the book's own preamble, then one `\vbox` per pinned box.
 *
 * `\typeout` rather than a written file, because `\typeout` works at any point and needs no
 * extra package; the log is parsed for the lines back out.
 */
function buildProbe(preamble, pinned) {
  const parts = [
    preamble,
    '\\begin{document}',
    // Comma-separated, NOT space-separated: TeX swallows the space that terminates a control
    // word, so `\the\textheight textwidth=` reaches the log as `542.025pttextwidth=`.
    '\\typeout{PINFIT-GEOMETRY textheight=\\the\\textheight,textwidth=\\the\\textwidth}',
    '',
  ];
  for (const box of pinned) {
    parts.push(`\\setbox0=\\vbox{%`);
    parts.push(box.source);
    parts.push(`}\\typeout{PINFIT-BOX ${box.index} = \\the\\dimexpr\\ht0+\\dp0\\relax}`);
    // Overwritten, NOT shipped: see the header. Putting an unbreakable box on a page is the
    // operation that hangs, so the measured box is thrown away as soon as it is measured.
    parts.push('\\setbox0=\\vbox{}');
    parts.push('');
  }
  parts.push('\\end{document}');
  return parts.join('\n');
}

function runXelatex(texPath, workdir, env, timeoutS, cwd) {
  return spawnSync('xelatex', [
    '-shell-escape',
    '-interaction=nonstopmode',
    `-output-directory=${workdir}`,
    texPath,
  ], {
    env,
    // The preamble names the fonts by a RELATIVE path (`Path = ./book-builder/fonts/`), so
    // the probe has to run from the same directory the real build does.
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    timeout: timeoutS * 1000,
    killSignal: 'SIGKILL',
  });
}

function parseMeasurements(log) {
  const heights = new Map();
  let geometry = null;
  // A \typeout can be wrapped by TeX at \maxprintline, so rejoin before matching.
  const flat = log.replace(/\n/g, '\u0001');
  for (const m of flat.matchAll(/PINFIT-BOX[\u0001\s]+(\d+)[\u0001\s]*=[\u0001\s]*([0-9.]+)pt/g)) {
    heights.set(Number(m[1]), Number(m[2]));
  }
  const g = /PINFIT-GEOMETRY[\u0001\s]+textheight=([0-9.]+)pt[\u0001\s]*,[\u0001\s]*textwidth=([0-9.]+)pt/.exec(flat);
  if (g) geometry = { textheight: Number(g[1]), textwidth: Number(g[2]) };
  return { heights, geometry };
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    tex: null,
    tolerance: DEFAULT_TOLERANCE_PT,
    workdir: null,
    json: null,
    timeout: DEFAULT_PROBE_TIMEOUT_S,
    quiet: false,
    cwd: null,
    env: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tolerance') opts.tolerance = Number(argv[++i]);
    else if (a === '--workdir') opts.workdir = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--quiet') opts.quiet = true;
    else if (!a.startsWith('--')) opts.tex = a;
  }
  return opts;
}

/**
 * @returns {{status:'pass'|'fail'|'not-checked', ...}} status is the only thing a caller has
 *   to read. 'not-checked' is never reported as a pass.
 */
function checkPinnedCallouts(options) {
  // Defaults applied HERE, not only in parseArgs(): build-book.js calls this directly and a
  // missing timeout used to reach spawnSync as NaN and throw before anything was measured.
  const opts = {
    tolerance: DEFAULT_TOLERANCE_PT,
    timeout: DEFAULT_PROBE_TIMEOUT_S,
    quiet: false,
    workdir: null,
    json: null,
    cwd: null,
    env: null,
    ...options,
  };
  if (!Number.isFinite(opts.tolerance)) opts.tolerance = DEFAULT_TOLERANCE_PT;
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) opts.timeout = DEFAULT_PROBE_TIMEOUT_S;
  const log = opts.quiet ? () => {} : (s) => console.log(s);
  const texPath = path.resolve(opts.tex);
  if (!fs.existsSync(texPath)) {
    return { status: 'not-checked', reason: `no such .tex: ${texPath}`, failures: [], drift: [] };
  }
  const tex = fs.readFileSync(texPath, 'utf8');
  const preamble = splitPreamble(tex);
  if (preamble === null) {
    return {
      status: 'not-checked',
      reason: `${path.basename(texPath)} has no \\begin{document}; cannot build a probe from its preamble`,
      failures: [], drift: [],
    };
  }

  const callouts = findCallouts(tex);
  const inconsistent = callouts.filter(
    (c) => c.source !== null && c.declaredPinned !== c.optionsPinned);
  const pinned = callouts.filter((c) => c.optionsPinned === true);
  const unparseable = callouts.filter((c) => c.source === null);

  log(`   callouts in the .tex: ${callouts.length} (pinned: ${pinned.length}, breakable: ${callouts.length - pinned.length})`);

  if (inconsistent.length > 0 || unparseable.length > 0) {
    // Refuse to answer rather than answer about the wrong boxes.
    return {
      status: 'fail',
      reason: 'the .tex does not parse as the filter emits it',
      failures: [...inconsistent, ...unparseable].map((c) => ({
        ...c,
        why: c.source === null
          ? 'no \\begin{tcolorbox}...\\end{tcolorbox} found after its %%CALLOUTFIT line'
          : `%%CALLOUTFIT says pinned=${c.declaredPinned ? 1 : 0} but the box options say ${c.optionsPinned ? 'breakable=false' : 'breakable'}`,
      })),
      drift: [], callouts,
    };
  }

  if (pinned.length === 0) {
    // Not a pass and not a failure: there was nothing to measure. This is the normal result
    // for a template that declares no \calloutPinBudget, which is how a consuming book with
    // its own geometry is kept away from the cliff.
    return { status: 'not-checked', reason: 'no pinned callouts in this document (pinning is off, or nothing fitted)', failures: [], drift: [], callouts };
  }

  const env = texEnv(opts.env);
  if (!haveXelatex(env)) {
    return { status: 'not-checked', reason: 'xelatex not found on PATH', failures: [], drift: [], callouts };
  }

  const workdir = opts.workdir
    ? path.resolve(opts.workdir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pinfit-'));
  fs.mkdirSync(workdir, { recursive: true });
  const probePath = path.join(workdir, 'pinfit-probe.tex');
  fs.writeFileSync(probePath, buildProbe(preamble, pinned));

  // TWO PASSES: minted's highlighted content is written on the first and read on the second.
  let last = null;
  for (let pass = 1; pass <= 2; pass += 1) {
    last = runXelatex(probePath, workdir, env, opts.timeout, opts.cwd);
    if (last.error && last.error.code === 'ETIMEDOUT') {
      return {
        status: 'not-checked',
        reason: `the fit probe's own xelatex pass ${pass} exceeded ${opts.timeout}s`,
        failures: [], drift: [], callouts, workdir,
      };
    }
  }
  const logPath = path.join(workdir, 'pinfit-probe.log');
  if (!fs.existsSync(logPath)) {
    return {
      status: 'not-checked',
      reason: `the fit probe produced no log (xelatex exit ${last ? last.status : '?'}); see ${workdir}`,
      failures: [], drift: [], callouts, workdir,
    };
  }
  const probeLog = fs.readFileSync(logPath, 'latin1');
  const { heights, geometry } = parseMeasurements(probeLog);

  // A TeX ERROR IN THE PROBE MEANS THE PROBE IS NOT THIS BOOK'S PREAMBLE, so its heights
  // describe a document the real build will not produce, and a green result over them would
  // be exactly the "clean pass over something not measured" this check is built to avoid.
  //
  // It is reported as NOT CHECKED rather than as a fit failure: the fault is in the preamble,
  // not in a box, and the real xelatex run is about to fail on it with `-halt-on-error` and a
  // better message. Found the hard way -- a pandoc template variable written inside a LaTeX
  // comment in book-print.latex pasted the header-includes block into the preamble, which
  // errored under nonstopmode ("You can't use \spacefactor in vertical mode") while the probe
  // measured on regardless and reported 123 boxes fitting.
  const texErrors = (probeLog.match(/^! .*$/gm) || []);
  if (texErrors.length > 0) {
    return {
      status: 'not-checked',
      reason: `the fit probe's own xelatex run logged ${texErrors.length} TeX error(s), so its ` +
        `preamble is not the one the book will be built with -- fix those first. ` +
        `First: ${texErrors[0].trim()} (full log: ${logPath})`,
      failures: [], drift: [], callouts, workdir, logPath,
    };
  }

  if (!geometry) {
    return {
      status: 'not-checked',
      reason: `the fit probe's log carries no geometry line; see ${logPath}`,
      failures: [], drift: [], callouts, workdir,
    };
  }
  // A box with no measurement is NOT a pass. Report it as a failure to measure, which is the
  // same class of answer as "it does not fit": we do not know that it does.
  const unmeasured = pinned.filter((b) => !heights.has(b.index));
  const usable = geometry.textheight;

  const measured = [];
  for (const box of pinned) {
    const h = heights.get(box.index);
    if (h === undefined) continue;
    measured.push({
      ...box,
      measured: h,
      fits: h <= usable,
      overBy: h - usable,
      driftBy: box.estimate === null ? null : h - box.estimate,
    });
  }

  const failures = measured.filter((b) => !b.fits);
  const drift = measured.filter((b) => b.driftBy !== null && b.driftBy > opts.tolerance);

  const result = {
    status: failures.length > 0 || unmeasured.length > 0 ? 'fail' : 'pass',
    usable,
    geometry,
    tolerance: opts.tolerance,
    callouts,
    pinnedCount: pinned.length,
    measured,
    failures,
    unmeasured,
    drift,
    workdir,
    logPath,
    tallest: measured.reduce((a, b) => (a === null || b.measured > a.measured ? b : a), null),
  };
  if (unmeasured.length > 0 && failures.length === 0) {
    result.reason = `${unmeasured.length} pinned box(es) produced no measurement; see ${logPath}`;
  }
  return result;
}

function describe(box) {
  const title = box.title ? `"${box.title}"` : '(untitled)';
  const ex = box.source ? excerpt(box.source) : '';
  return `${box.type} ${title}${ex ? `\n       content: ${ex}` : ''}`;
}

function report(result, opts) {
  const log = (s) => console.log(s);
  if (result.status === 'not-checked') {
    log(`⚠️  Pinned-callout fit check NOT CHECKED: ${result.reason}`);
    return;
  }

  log(`   text block: ${result.usable}pt; tolerance for estimator drift: ${result.tolerance}pt`);
  if (result.tallest) {
    log(`   tallest pinned box measures ${result.tallest.measured.toFixed(2)}pt ` +
        `(${((result.tallest.measured / result.usable) * 100).toFixed(1)}% of the text block)`);
  }

  if (result.drift && result.drift.length > 0) {
    log('');
    log(`⚠️  ESTIMATOR DRIFT: ${result.drift.length} pinned box(es) measure taller than the ` +
        `estimate they were pinned on, by more than ${result.tolerance}pt.`);
    log(`   This is a FIT-constant bug in callout-filter-print.lua, not a fit failure: every`);
    log(`   box below still fits the page. Re-derive the constants with`);
    log(`   scripts/__tests__/fixtures/fit-probe.md -- an estimate that runs LOW is how a box`);
    log(`   that fits today becomes a hung build after a sentence is added to it.`);
    for (const b of result.drift.sort((x, y) => y.driftBy - x.driftBy)) {
      log(`   - +${b.driftBy.toFixed(2)}pt  measured ${b.measured.toFixed(2)} vs estimate ` +
          `${b.estimate.toFixed(2)}  ${describe(b)}`);
    }
  }

  if (result.failures.length > 0 || (result.unmeasured && result.unmeasured.length > 0)) {
    log('');
    log('❌ PINNED CALLOUT DOES NOT FIT THE TEXT BLOCK.');
    log('   A pinned (breakable=false) box taller than the page does not warn and does not');
    log('   overfull: xelatex never terminates. The print build is stopped here on purpose.');
    if (result.reason) log(`   ${result.reason}`);
    for (const b of result.failures) {
      log(`   - ${b.measured.toFixed(2)}pt, ${b.overBy.toFixed(2)}pt over the ${result.usable}pt ` +
          `text block (estimate was ${b.estimate === null ? '?' : b.estimate.toFixed(2)}pt)`);
      log(`     ${describe(b)}`);
    }
    for (const b of (result.unmeasured || [])) {
      log(`   - NOT MEASURED (no height in the probe log): ${describe(b)}`);
    }
    log('');
    log('   To unblock without risking the hang, comment out \\calloutPinBudget in the print');
    log('   template: every callout goes back to breakable, which splits a few boxes and');
    log('   cannot hang. Then fix the estimator.');
    return;
  }

  log(`✅ Pinned-callout fit check: all ${result.pinnedCount} pinned box(es) fit the ` +
      `${result.usable}pt text block (measured, not estimated).`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.tex) {
    console.error('usage: check-pinned-callouts.js <book.tex> [--tolerance PT] [--workdir DIR] [--json OUT] [--timeout S] [--quiet]');
    process.exit(2);
  }
  const result = checkPinnedCallouts(opts);
  report(result, opts);
  if (opts.json) {
    fs.writeFileSync(opts.json, `${JSON.stringify({
      status: result.status,
      reason: result.reason || null,
      usable: result.usable || null,
      tolerance: result.tolerance || null,
      pinnedCount: result.pinnedCount || 0,
      calloutCount: (result.callouts || []).length,
      measured: (result.measured || []).map((b) => ({
        index: b.index, type: b.type, title: b.title,
        estimate: b.estimate, measured: b.measured, fits: b.fits, driftBy: b.driftBy,
      })),
      failures: (result.failures || []).map((b) => ({
        index: b.index, type: b.type, title: b.title, measured: b.measured, overBy: b.overBy,
      })),
      drift: (result.drift || []).map((b) => ({
        index: b.index, type: b.type, title: b.title,
        estimate: b.estimate, measured: b.measured, driftBy: b.driftBy,
      })),
    }, null, 2)}\n`);
  }
  // 'not-checked' exits 0: consistent with the rest of this build system, which degrades to
  // "not measured" rather than failing a build over a missing measurement tool. It is never
  // reported as a pass.
  process.exit(result.status === 'fail' ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  checkPinnedCallouts,
  report,
  splitPreamble,
  extractEnvironment,
  parseProvenance,
  findCallouts,
  buildProbe,
  excerpt,
  DEFAULT_TOLERANCE_PT,
};
