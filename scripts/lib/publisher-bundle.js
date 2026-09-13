'use strict';

const fs = require('fs');

// Single source of truth for the metadata-file list. The dependency runs one way,
// publisher-bundle -> publisher-guard, and never back.
const { BUNDLE_META_FILES } = require('./publisher-guard.js');

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

module.exports = { EXPECTED_FILES, BUNDLE_META_FILES, normalizeBuffer, readAndNormalize };
