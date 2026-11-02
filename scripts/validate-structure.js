#!/usr/bin/env node

/**
 * Structure check: one-line blocks that can strand at a page foot.
 *
 * \clubpenalty only acts on a paragraph that has more than one line. A
 * one-line paragraph (a bold label such as `**Day 1: ...**` standing alone)
 * has no line break to penalise, so it can land alone at the bottom of a page
 * whatever the penalties are set to. This finds them in source.
 *
 * This is a WARNING and always exits 0. Standalone bold labels are often a
 * legitimate choice, and this builder is shared by several books; a check that
 * failed their builds would be switched off. The author decides.
 */

const fs = require('fs');
const path = require('path');

// A whole line that is one bold span: **text** (no nested ** inside).
const BOLD_ONLY = /^\*\*((?:(?!\*\*).)+?)\*\*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Find paragraphs that consist of exactly one line which is entirely bold.
 * Run-in leads (bold followed by prose on the same line), bold inside fenced
 * code, and bold lines that belong to a multi-line paragraph are not reported.
 * @returns {{file: string, line: number, text: string}[]} line is 1-based
 */
function findStrandableBlocks(markdown, filename) {
  const lines = markdown.split(/\r?\n/);
  const found = [];
  let fence = null; // the opening fence marker while inside fenced code

  const blank = (i) => i < 0 || i >= lines.length || lines[i].trim() === '';

  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }

    const m = BOLD_ONLY.exec(lines[i]);
    if (m && blank(i - 1) && blank(i + 1)) {
      found.push({ file: filename, line: i + 1, text: m[1].trim() });
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
  for (const p of patterns) {
    if (/[*?[{]/.test(p)) files.push(...glob.sync(path.resolve(root, p)).sort());
    else if (fs.existsSync(path.resolve(root, p))) files.push(path.resolve(root, p));
  }
  return { root, files };
}

function main() {
  const config = require('../config/book.config.js');
  const { root, files } = manuscriptFiles(config);

  if (files.length === 0) {
    // An empty file list would otherwise look exactly like a clean result.
    console.warn(`WARNING: validate-structure scanned 0 files under ${root}. ` +
      'Nothing was checked; the source paths in book.config.js may be wrong.');
    return;
  }

  let total = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    for (const b of findStrandableBlocks(fs.readFileSync(file, 'utf8'), rel)) {
      console.warn(`WARNING ${b.file}:${b.line}  one-line bold block: "${b.text}"`);
      total++;
    }
  }
  console.log(`validate-structure: scanned ${files.length} files, ${total} warning(s). ` +
    'A one-line block cannot be protected by \\clubpenalty and may strand at a page foot; ' +
    'fold it into the paragraph it introduces if that is a problem. (Warnings only; exit 0.)');
}

if (require.main === module) main();

module.exports = { findStrandableBlocks };
