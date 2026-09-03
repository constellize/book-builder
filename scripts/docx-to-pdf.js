#!/usr/bin/env node

/**
 * docx-to-pdf.js — render a .docx to PDF with ZERO interactive prompts.
 *
 *     node scripts/docx-to-pdf.js templates/docx/reference-digital.docx
 *     node scripts/docx-to-pdf.js ref.docx --engine both --png 1
 *     node scripts/docx-to-pdf.js ref.docx --engine word -o /tmp/out.pdf
 *
 * Default engine is LibreOffice: prompt-free because it is not sandboxed, and
 * the only engine that exists in CI. Word is available for fidelity checks and
 * is the only engine that fills in a live { TOC } field -- see
 * scripts/lib/docx-render.js for the full account of both Word prompts and the
 * measurements behind each defence.
 *
 * `--engine both` renders with each and prints a comparison table. That is the
 * fidelity-check workflow: LibreOffice for the fast loop, Word to confirm the
 * fast loop is not lying to you.
 *
 * Exit codes:  0 ok   1 conversion/environment failure   2 bad usage
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const { Command } = require('commander');

const render = require('./lib/docx-render.js');

const ENGINE_LABEL = { libreoffice: 'LibreOffice', word: 'Word' };

// ---------------------------------------------------------------------------
// Output paths
// ---------------------------------------------------------------------------

/**
 * Where does each engine's PDF go?
 *
 * With no --out, beside the input. That is deliberate and safe for BOTH
 * engines: LibreOffice is unsandboxed, and the Word path stages inside
 * ~/Library/Containers/com.microsoft.Word/Data/ and moves the result out with
 * this process, so the caller's directory never faces the App Sandbox powerbox.
 * /private/tmp, build/ and the Desktop are all equally fine.
 */
function resolveOutputs(input, out, engines) {
  const stem = path.basename(input, path.extname(input));

  let dir;
  let base = null;
  if (!out) {
    dir = path.dirname(path.resolve(input));
  } else {
    const abs = path.resolve(out);
    const isDir = out.endsWith(path.sep) || (fs.existsSync(abs) && fs.statSync(abs).isDirectory());
    if (isDir) {
      dir = abs;
    } else {
      dir = path.dirname(abs);
      base = path.basename(abs, '.pdf');
    }
  }

  const name = base || stem;
  const map = {};
  for (const e of engines) {
    map[e] = path.join(dir, engines.length > 1 ? `${name}-${e}.pdf` : `${name}.pdf`);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Relative when that is shorter and readable, absolute otherwise. */
function show(p) {
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith('..') || rel.length >= p.length ? p : rel;
}

function reportNotes(notes) {
  for (const n of notes || []) {
    switch (n.kind) {
      case 'pref-recovery':
        if (n.recovered) {
          console.log(
            chalk.yellow(
              `  recovered: a previous run left ${render.PREF_UI_PATH} off; restored to ` +
                `${n.restoredTo ? 'ON' : 'OFF'}`
            )
          );
        } else {
          console.log(chalk.red(`  pref journal found but not restored: ${n.reason}`));
        }
        break;
      case 'pref-toggled':
        console.log(
          chalk.gray(`  ${render.PREF_UI_PATH} temporarily OFF (fields updated explicitly instead)`)
        );
        break;
      case 'pref-restored':
        console.log(chalk.gray(`  ${render.PREF_UI_PATH} restored to ${n.to ? 'ON' : 'OFF'}`));
        break;
      case 'pref-untouched':
        console.log(chalk.gray(`  preference left alone (${n.reason})`));
        break;
      case 'pref-restore-failed':
        console.log(chalk.red.bold(`  COULD NOT RESTORE ${render.PREF_UI_PATH}`));
        console.log(chalk.red(`  ${n.hint}`));
        break;
      default:
        break;
    }
  }
}

function comparisonTable(results) {
  const rows = results.map((r) => {
    const i = render.inspectPdf(r.pdf);
    return {
      engine: ENGINE_LABEL[r.engine],
      time: `${(r.ms / 1000).toFixed(2)}s`,
      size: kb(i.bytes),
      pages: i.pages === null ? '?' : String(i.pages),
      toc: i.tocLines === null ? '?' : String(i.tocLines),
      fonts: i.fonts ? i.fonts.length : '?',
      fontList: i.fonts || [],
    };
  });

  const head = ['engine', 'time', 'size', 'pages', 'TOC lines', 'fonts'];
  const cells = rows.map((r) => [r.engine, r.time, r.size, r.pages, r.toc, String(r.fonts)]);
  const w = head.map((h, c) => Math.max(h.length, ...cells.map((row) => row[c].length)));
  const line = (vals, style) =>
    console.log('  ' + style(vals.map((v, c) => v.padEnd(w[c])).join('  ')));

  console.log(chalk.bold('\nComparison'));
  line(head, chalk.gray);
  for (const row of cells) line(row, (s) => s);

  for (const r of rows) {
    if (r.fontList.length) {
      console.log(chalk.gray(`  ${r.engine} fonts: ${r.fontList.join(', ')}`));
    }
  }

  // The one difference that actually bites, called out rather than left in the
  // numbers: LibreOffice does not update field results on import.
  const lo = rows.find((r) => r.engine === 'LibreOffice');
  const wd = rows.find((r) => r.engine === 'Word');
  if (lo && wd && lo.toc === '0' && wd.toc !== '0' && wd.toc !== '?') {
    console.log(
      chalk.yellow(
        `\n  TOC differs by design: LibreOffice does not update { TOC } fields on import ` +
          `(0 entries vs Word's ${wd.toc}). Not a styling regression.`
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const program = new Command();
  program
    .name('docx-to-pdf')
    .description('Render a .docx to PDF with zero interactive prompts (macOS).')
    .argument('<input.docx>', 'path to the .docx to render')
    .option(
      '-e, --engine <name>',
      `${render.ENGINES.join(' | ')}  ("both" renders twice and compares)`,
      'libreoffice'
    )
    .option('-o, --out <path>', 'output .pdf, or a directory (default: beside the input)')
    .option('--png [page]', 'also rasterise page N of each PDF (default page 1)')
    .option('--density <dpi>', 'rasterisation density for --png', '130')
    .option('--timeout <seconds>', 'per-engine timeout', '180')
    .option(
      '--no-word-pref-toggle',
      "never touch Word's \"update automatic links at open\" preference; " +
        'report what to change instead'
    )
    .option('-v, --verbose', 'show engine stderr')
    .showHelpAfterError();

  program.parse();

  const opts = program.opts();
  const input = path.resolve(program.args[0]);

  if (!render.ENGINES.includes(opts.engine)) {
    console.error(chalk.red(`Unknown engine "${opts.engine}"; expected ${render.ENGINES.join(' | ')}`));
    process.exit(2);
  }
  if (!fs.existsSync(input)) {
    console.error(chalk.red(`Input not found: ${input}`));
    process.exit(2);
  }
  if (!fs.statSync(input).isFile()) {
    console.error(chalk.red(`Input is not a file: ${input}`));
    process.exit(2);
  }
  if (path.extname(input).toLowerCase() !== '.docx') {
    console.error(chalk.red(`Input is not a .docx: ${input}`));
    process.exit(2);
  }

  const timeoutMs = Math.max(1, parseInt(opts.timeout, 10) || 180) * 1000;
  const engines = opts.engine === 'both' ? ['libreoffice', 'word'] : [opts.engine];
  const outputs = resolveOutputs(input, opts.out, engines);

  const pngPage = opts.png === undefined ? null : (opts.png === true ? 1 : parseInt(opts.png, 10));
  if (pngPage !== null && (!Number.isInteger(pngPage) || pngPage < 1)) {
    console.error(chalk.red(`--png expects a 1-based page number, got "${opts.png}"`));
    process.exit(2);
  }

  console.log(chalk.blue(`\nRendering ${path.basename(input)}`));
  console.log(chalk.gray(`  ${input}`));

  const fields = render.docxFieldInfo(input);
  if (fields.hasToc && engines.includes('libreoffice') && !engines.includes('word')) {
    console.log(
      chalk.yellow(
        '  note: this document has a { TOC } field. LibreOffice does not update it, ' +
          'so the rendered TOC will be empty. Use --engine word (or both) to see it filled.'
      )
    );
  }

  const results = [];
  for (const engine of engines) {
    const out = outputs[engine];
    process.stdout.write(chalk.gray(`  ${ENGINE_LABEL[engine]} ... `));
    let r;
    try {
      r =
        engine === 'libreoffice'
          ? render.renderLibreOffice(input, out, { timeoutMs })
          : render.renderWord(input, out, {
              timeoutMs,
              allowPrefToggle: opts.wordPrefToggle !== false,
            });
    } catch (err) {
      console.log(chalk.red('failed'));
      throw err;
    }
    console.log(
      chalk.green(`${(r.ms / 1000).toFixed(2)}s`) +
        chalk.gray(` -> ${show(r.pdf)} (${kb(fs.statSync(r.pdf).size)})`)
    );
    reportNotes(r.notes);
    if (opts.verbose && r.stderr && r.stderr.trim()) {
      for (const l of r.stderr.trim().split('\n')) console.log(chalk.gray(`    ${l}`));
    }
    results.push(r);
  }

  if (pngPage !== null) {
    for (const r of results) {
      const png = path.join(
        path.dirname(r.pdf),
        `${path.basename(r.pdf, '.pdf')}-p${pngPage}.png`
      );
      const g = render.rasterize(r.pdf, png, {
        page: pngPage,
        density: parseInt(opts.density, 10) || 130,
      });
      console.log(
        chalk.gray(
          `  png page ${pngPage} @ ${g.density}dpi -> ${show(g.png)}`
        )
      );
      r.png = g.png;
    }
  }

  if (results.length > 1) comparisonTable(results);

  console.log(chalk.green.bold('\nDone.'));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    if (err instanceof render.RenderError) {
      console.error(chalk.red.bold(`\n${err.code}: ${err.message}`));
      if (err.hint) console.error(chalk.yellow(err.hint));
    } else {
      console.error(chalk.red(`\n${err.stack || err.message}`));
    }
    process.exit(1);
  }
}

module.exports = { resolveOutputs };
