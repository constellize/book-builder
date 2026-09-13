'use strict';

const fs = require('fs');

// Single source of truth for the metadata-file list. The dependency runs one way,
// publisher-bundle -> publisher-guard, and never back.
const { BUNDLE_META_FILES, KIND, tokenize } = require('./publisher-guard.js');

/** The 13 files build-book.js reads, in the order it reads them. */
const EXPECTED_FILES = Object.freeze([
  'foreword-faq.md',
  'introduction.md',
  'ch1.md', 'ch2.md', 'ch3.md', 'ch4.md', 'ch5.md',
  'ch6.md', 'ch7.md', 'ch8.md', 'ch9.md',
  'appA.md', 'appB.md',
]);

/**
 * Decode and normalize a returned file.
 *
 * Decoding is fatal rather than lossy on purpose. Node's default UTF-8 decode
 * substitutes U+FFFD for invalid bytes, which turns a broken export into plausible
 * text that merges cleanly and ships a corrupted em-dash. Failing here means the
 * guard can report `encoding` and stop.
 */
function normalizeBuffer(buffer) {
  const notes = { invalidUtf8: false, hadBom: false, hadCrlf: false, addedTrailingNewline: false };

  let bytes = buffer;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    notes.hadBom = true;
    bytes = bytes.subarray(3);
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    notes.invalidUtf8 = true;
    return { text: '', notes };
  }

  if (text.includes('\r\n')) {
    notes.hadCrlf = true;
    text = text.replace(/\r\n/g, '\n');
  }
  text = text.replace(/\r/g, '\n');

  const trimmed = text.replace(/\n+$/, '');
  if (!text.endsWith('\n')) notes.addedTrailingNewline = true;
  text = trimmed + '\n';

  return { text, notes };
}

function readAndNormalize(filePath) {
  return normalizeBuffer(fs.readFileSync(filePath));
}

const collapse = (s) => s.split(/\s+/).join(' ').trim();

/**
 * Find top-level paragraph blocks: maximal runs of `text` lines that sit outside any
 * ::: div and carry no leading whitespace.
 *
 * The narrowness is the safety. Lists, tables, fenced and indented code, and div
 * bodies all carry meaning in their whitespace, so none of them are candidates.
 */
function paragraphBlocks(text) {
  const { lines } = tokenize(text);
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const eligible =
      line.kind === KIND.TEXT && line.divDepth === 0 && !/^\s/.test(line.raw);
    if (eligible) {
      if (current === null) current = { start: line.n - 1, lines: [] };
      current.lines.push(line.raw);
    } else if (current !== null) {
      blocks.push(current);
      current = null;
    }
  }
  if (current !== null) blocks.push(current);

  return blocks.map((b) => ({ ...b, end: b.start + b.lines.length, key: collapse(b.lines.join(' ')) }));
}

/**
 * Restore the snapshot's line breaks for paragraphs the publisher only re-wrapped.
 *
 * Matching is by *unique* collapsed text, not by position. Positional matching
 * misaligns the moment a paragraph is inserted or deleted; unique matching simply
 * declines to act when it cannot be certain, which is the correct failure direction
 * for a pass that rewrites the publisher's bytes.
 */
function dewrapParagraphs(snapshotText, returnedText) {
  const snapshotBlocks = paragraphBlocks(snapshotText);

  const byKey = new Map();
  for (const block of snapshotBlocks) {
    if (byKey.has(block.key)) byKey.set(block.key, null); // ambiguous: never use
    else byKey.set(block.key, block);
  }

  const returnedBlocks = paragraphBlocks(returnedText);
  const outLines = returnedText.split('\n');
  let dewrapped = 0;

  // Apply back-to-front so earlier splice indices stay valid.
  for (let i = returnedBlocks.length - 1; i >= 0; i--) {
    const block = returnedBlocks[i];
    const match = byKey.get(block.key);
    if (!match) continue;
    if (match.lines.join('\n') === block.lines.join('\n')) continue; // already identical
    outLines.splice(block.start, block.lines.length, ...match.lines);
    dewrapped++;
  }

  return { text: outLines.join('\n'), dewrapped };
}

module.exports = {
  EXPECTED_FILES, BUNDLE_META_FILES,
  normalizeBuffer, readAndNormalize, dewrapParagraphs,
};
