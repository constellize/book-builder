#!/usr/bin/env node

/**
 * docx-to-pdf.js — render a .docx to PDF with ZERO interactive prompts.
 *
 *     node scripts/docx-to-pdf.js templates/docx/reference-digital.docx
 *     node scripts/docx-to-pdf.js ref.docx --engine both --png 1
 *     node scripts/docx-to-pdf.js ref.docx --engine word -o /tmp/out.pdf
 *
 * The default engine is `auto`, and it exists because the two engines do not
 * agree about page parity. LibreOffice drops the implicit blank verso that an
 * `oddPage` section break needs, so a book built with open-right chapters
 * renders four pages short, with chapters on versos and mirrored margins bound
 * on the wrong edge -- while the logical page numbers stay correct, which is
 * what makes it convincing. `auto` reads the document and sends anything with
 * mid-document open-right breaks to Word; everything else keeps the fast
 * LibreOffice path. `--engine libreoffice` still does exactly what it says and
 * is still the CI engine; it just cannot produce that wrong proof in silence.
 * The measurements are in scripts/lib/docx-render.js, together with the full
 * account of the two Word prompts and the defence against each.
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
      case 'stage-swept':
        console.log(
          chalk.yellow(
            `  swept ${n.removed} staged file${n.removed === 1 ? '' : 's'} left by a killed run ` +
              '(they wedge Word if left in place)'
          )
        );
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

/**
 * The banner that has to be impossible to scroll past.
 *
 * Printed whenever LibreOffice is the sole engine for a document that declares
 * mid-document open-right breaks -- i.e. exactly the case that used to produce a
 * plausible-looking, wrong print proof with no warning at all.
 */
function notAProofBanner(layout, { wordMissing }) {
  const bar = '='.repeat(74);
  console.log(chalk.red.bold(`\n${bar}`));
  console.log(chalk.red.bold('  THIS PDF IS NOT A VALID PRINT PROOF'));
  console.log(chalk.red.bold(bar));
  console.log(
    chalk.red(
      `  The document declares ${layout.openRightBreaks} open-right ` +
        `(${layout.sectionTypes.join('/')}) section breaks.\n` +
        '  LibreOffice does not insert the implicit blank versos they require, so\n' +
        '  from the first dropped blank onward every PHYSICAL page has the wrong\n' +
        '  parity: chapters land on versos, running heads sit on the wrong side.'
    )
  );
  if (layout.mirrorMargins || layout.gutter) {
    console.log(
      chalk.red(
        `  This document also uses ${layout.mirrorMargins ? 'mirrored margins' : 'a binding gutter'}` +
          `${layout.gutter ? ` (gutter ${layout.gutter} twips)` : ''}, which the same\n` +
          '  parity shift binds on the wrong edge.'
      )
    );
  }
  console.log(
    chalk.yellow(
      '\n  The logical page numbers are still correct, so nothing in the PDF itself\n' +
        '  will tell you this. Do not check openright with it.'
    )
  );
  console.log(
    chalk.cyan(
      wordMissing
        ? '\n  Fix: render on a machine with Microsoft Word (the default engine "auto"\n' +
            '  would have chosen it). LibreOffice output is fine for text, styling and\n' +
            '  font checks -- just not for page parity.'
        : '\n  Fix: drop --engine libreoffice (the default "auto" picks Word here), or\n' +
            '  pass --engine both to see the divergence measured side by side.'
    )
  );
  console.log(chalk.red.bold(`${bar}\n`));
}

function comparisonTable(results, layout) {
  const rows = results.map((r) => {
    const i = render.inspectPdf(r.pdf);
    const blanks = r.blanks === undefined ? render.pdfBlankPages(r.pdf) : r.blanks;
    return {
      engine: ENGINE_LABEL[r.engine],
      time: `${(r.ms / 1000).toFixed(2)}s`,
      size: kb(i.bytes),
      pages: i.pages === null ? '?' : String(i.pages),
      toc: i.tocLines === null ? '?' : String(i.tocLines),
      fonts: i.fonts ? i.fonts.length : '?',
      fontList: i.fonts || [],
      blanks: blanks === null ? '?' : String(blanks.length),
      blankList: blanks || [],
      pageCount: i.pages,
    };
  });

  const head = ['engine', 'time', 'size', 'pages', 'blanks', 'TOC lines', 'fonts'];
  const cells = rows.map((r) => [
    r.engine,
    r.time,
    r.size,
    r.pages,
    r.blanks,
    r.toc,
    String(r.fonts),
  ]);
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

  // Two differences that actually bite, called out rather than left in the
  // numbers for the reader to notice.
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

  // A page-count gap on an open-right document is the parity defect, measured.
  // This one IS a regression in the LibreOffice output, not a difference of
  // opinion, so it is red rather than yellow.
  if (lo && wd && layout && layout.needsWord && lo.pageCount !== null && wd.pageCount !== null) {
    if (lo.pageCount !== wd.pageCount) {
      const dropped = wd.pageCount - lo.pageCount;
      console.log(
        chalk.red.bold(
          `\n  PARITY: LibreOffice is ${dropped} page${dropped === 1 ? '' : 's'} short ` +
            `(${lo.pageCount} vs ${wd.pageCount}).`
        )
      );
      console.log(
        chalk.red(
          `  Word inserted blank versos at ${wd.blankList.join(', ') || '(none found)'}; ` +
            `LibreOffice inserted ${lo.blankList.length}.\n` +
            '  Every physical page after the first dropped blank has inverted parity.\n' +
            '  Trust the Word column for anything about page sides. See --engine word.'
        )
      );
    } else {
      console.log(
        chalk.green(
          `\n  Parity: both engines produced ${wd.pageCount} pages on an open-right ` +
            'document; no blank verso was dropped.'
        )
      );
    }
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
      `${render.ENGINES.join(' | ')}  ` +
        '("auto" = Word for open-right documents, LibreOffice otherwise; ' +
        '"both" renders twice and compares)',
      'auto'
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

  // Engine choice is a property of the DOCUMENT, not of the filename: see
  // render.selectEngines(). reference-digital.docx is open-right with a binding
  // gutter too, so nothing here may key off "print" appearing in a name.
  const choice = render.selectEngines(input, opts.engine);
  const engines = choice.engines;
  const layout = choice.layout;
  const outputs = resolveOutputs(input, opts.out, engines);

  const pngPage = opts.png === undefined ? null : (opts.png === true ? 1 : parseInt(opts.png, 10));
  if (pngPage !== null && (!Number.isInteger(pngPage) || pngPage < 1)) {
    console.error(chalk.red(`--png expects a 1-based page number, got "${opts.png}"`));
    process.exit(2);
  }

  console.log(chalk.blue(`\nRendering ${path.basename(input)}`));
  console.log(chalk.gray(`  ${input}`));

  if (layout.readable) {
    console.log(
      chalk.gray(
        `  layout: ${layout.sections} section${layout.sections === 1 ? '' : 's'}, ` +
          `${layout.openRightBreaks} open-right break${layout.openRightBreaks === 1 ? '' : 's'}` +
          `${layout.mirrorMargins ? ', mirrored margins' : ''}` +
          `${layout.gutter ? `, gutter ${layout.gutter}` : ''}`
      )
    );
  }
  if (opts.engine === 'auto' && choice.reason) {
    const line = `  engine: auto -> ${engines.map((e) => ENGINE_LABEL[e]).join(' + ')} (${choice.reason})`;
    console.log(choice.wordMissing ? chalk.yellow(line) : chalk.gray(line));
  }

  // Announced BEFORE the render as well as after it, so an operator who kills a
  // long run still saw it.
  if (choice.notProof) notAProofBanner(layout, { wordMissing: choice.wordMissing });

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

    // The corroborating measurement, printed for every open-right render so the
    // claim is never "trust the engine name": the blank versos are either there
    // or they are not.
    if (layout.needsWord) {
      r.blanks = render.pdfBlankPages(r.pdf);
      if (r.blanks !== null) {
        console.log(
          chalk.gray(
            `  blank versos: ${r.blanks.length}` +
              (r.blanks.length ? ` (physical page${r.blanks.length === 1 ? '' : 's'} ${r.blanks.join(', ')})` : '')
          )
        );
      }
    }

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

  if (results.length > 1) comparisonTable(results, layout);

  // Repeated after the render too: the banner above has scrolled off by now on a
  // --png run, and this is the last thing the operator reads before using the file.
  if (choice.notProof) {
    notAProofBanner(layout, { wordMissing: choice.wordMissing });
    console.log(chalk.green.bold('Done') + chalk.red.bold(' — but see the warning above.'));
    return;
  }

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
