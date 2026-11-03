#!/usr/bin/env node

/**
 * Structure check: one-line blocks that can strand at a page foot.
 *
 * \clubpenalty only acts on a paragraph that has more than one line. A
 * one-line paragraph (a bold label such as `**Day 1: ...**` standing alone)
 * has no line break to penalise, so it can land alone at the bottom of a page
 * whatever the penalties are set to. This finds them in source.
 *
 * EXIT CODES. Warnings about the manuscript are exit 0, always: standalone bold labels are
 * often a legitimate choice, and this builder is shared by several books; a check that failed
 * their builds would be switched off. The author decides.
 *
 * Exit 2 means something else entirely -- the check did NOT measure what it was asked to
 * measure: no config, no `glob`, zero files, a file it could not read. That has to be
 * distinguishable from a clean run, because `make lint` used to print a green pass over the
 * top of "nothing was checked" and the only honest reading of that line was "unknown".
 * Nothing in a book BUILD runs this script, so a non-zero exit here cannot break one.
 */

const fs = require('fs');
const path = require('path');

// A whole line that is one emphasis span: **x**, __x__, ***x*** or ___x___,
// optionally followed by trailing punctuation (`**Label**:`). The inner text may
// not contain the delimiter, so `**a** and **b**` is not one span.
const BOLD_ONLY = /^(\*{2,3}|_{2,3})(?!\s)((?:(?!\1).)+?)\1[:.,;!?]*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const DIV = /^\s*:{3,}/;

/**
 * Find paragraphs that consist of exactly one line which is entirely bold.
 * A paragraph ends at a blank line, an ATX heading, a fenced-code delimiter or
 * a `:::` div line (pandoc ends paragraphs at all of these), so a bold line
 * directly after a heading is still a one-line paragraph.
 *
 * Not reported: run-in leads (bold followed by prose on the line), bold inside
 * fenced code, bold lines that belong to a multi-line paragraph, and bold in
 * list items or blockquotes (`> **x**`, `- **x**`) which are not bare
 * paragraphs. That exclusion is a decision, not an oversight.
 * @returns {{file: string, line: number, text: string}[]} line is 1-based
 */
function findStrandableBlocks(markdown, filename) {
  const lines = markdown.split(/\r?\n/);
  const kind = new Array(lines.length); // 'text' | 'boundary' | 'code'
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) { fence = null; kind[i] = 'boundary'; }
      else kind[i] = 'code';
    } else if (f) { fence = f[1]; kind[i] = 'boundary'; }
    else if (l.trim() === '' || HEADING.test(l) || DIV.test(l)) kind[i] = 'boundary';
    else kind[i] = 'text';
  }

  const edge = (i) => i < 0 || i >= lines.length || kind[i] === 'boundary';
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (kind[i] !== 'text') continue;
    const m = BOLD_ONLY.exec(lines[i]);
    if (m && edge(i - 1) && edge(i + 1)) {
      found.push({ file: filename, line: i + 1, text: m[2].trim() });
    }
  }
  return found;
}

function manuscriptFiles(config) {
  const glob = require('glob');
  const root = config.source.root;
  const patterns = [
    config.source.foreword,
    config.source.introduction,
    ...(config.source.chapters || []),
    ...(config.source.appendices || []),
  ].filter(Boolean);
  const files = [];
  const missing = [];
  for (const p of patterns) {
    if (/[*?[{]/.test(p)) files.push(...glob.sync(path.resolve(root, p)).sort());
    else if (fs.existsSync(path.resolve(root, p))) files.push(path.resolve(root, p));
    else missing.push(p);
  }
  return { root, files, missing };
}

// "The check did not run" is not "the check found nothing". Reachable for a consuming book
// that has not run `npm install` in the submodule: `glob` and `../config/book.config.js` are
// both required inside main().
const EXIT_NOT_MEASURED = 2;

function main() {
  const config = require('../config/book.config.js');
  const { root, files, missing } = manuscriptFiles(config);
  let notChecked = 0;
  for (const m of missing) {
    console.warn(`WARNING configured source file not found, not checked: ${m}`);
    notChecked++;
  }

  if (files.length === 0) {
    // An empty file list would otherwise look exactly like a clean result.
    console.warn(`WARNING: validate-structure scanned 0 files under ${root}. ` +
      'Nothing was checked; the source paths in book.config.js may be wrong.');
    process.exitCode = EXIT_NOT_MEASURED;
    return;
  }

  let total = 0, scanned = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    try {
      for (const b of findStrandableBlocks(fs.readFileSync(file, 'utf8'), rel)) {
        console.warn(`WARNING ${b.file}:${b.line}  one-line bold block: "${b.text}"`);
        total++;
      }
      scanned++;
    } catch (err) {
      // A directory matched by a glob, a broken symlink, a permissions problem. Without this
      // catch the throw escaped to the outer one, which abandoned every REMAINING file while
      // printing "nothing was checked" -- so a single bad entry silently stopped the scan and
      // reported it as if the whole run had failed.
      console.warn(`WARNING ${rel} could not be read, NOT checked: ${err && err.message}`);
      notChecked++;
    }
  }
  console.log(`validate-structure: scanned ${scanned} of ${scanned + notChecked} configured ` +
    `files, ${total} warning(s). ` +
    'A one-line block cannot be protected by \\clubpenalty and may strand at a page foot; ' +
    'fold it into the paragraph it introduces if that is a problem. ' +
    '(Manuscript warnings do not fail this check.)');
  if (notChecked) {
    console.warn(`WARNING: ${notChecked} configured file(s) were NOT checked (listed above), ` +
      'so this run did not measure the whole manuscript. Exiting non-zero to say so.');
    process.exitCode = EXIT_NOT_MEASURED;
  }
}

if (require.main === module) {
  // Manuscript warnings never fail anything. A check that could not RUN says so, with a
  // non-zero exit, because `make lint` printed a green pass over the top of this warning and
  // a lint target that checked nothing read as a clean one.
  //
  // process.exitCode, not process.exit(): process.exit() can truncate piped stdout, and this
  // script's output is the whole point of running it.
  try {
    main();
  } catch (err) {
    console.warn(`WARNING validate-structure could not run (nothing was checked): ${err && err.message}`);
    process.exitCode = EXIT_NOT_MEASURED;
  }
}

module.exports = { findStrandableBlocks, manuscriptFiles };
