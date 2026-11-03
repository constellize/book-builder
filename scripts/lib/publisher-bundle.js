'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

// Single source of truth for the metadata-file list. The dependency runs one way,
// publisher-bundle -> publisher-guard, and never back.
const { BUNDLE_META_FILES, KIND, tokenize } = require('./publisher-guard.js');

/** The files build-book.js reads, in the order it reads them. */
const EXPECTED_FILES = Object.freeze([
  'foreword-faq.md',
  'introduction.md',
  'ch1.md', 'ch2.md', 'ch3.md', 'ch4.md', 'ch5.md',
  'ch6.md', 'ch7.md', 'ch8.md', 'ch9.md',
  'appA.md', 'appB.md', 'appC.md',
]);

/**
 * Resolve a `--round` value to the label used verbatim in the tag `publisher/<label>`,
 * the workspace directory, and the bundle name. A bare integer is prefixed with
 * `round-`; anything else is lowercased and sanitized. With no value, the default is
 * the next unused integer.
 *
 * This lives in the bundle lib, not in package-for-publisher.js, because BOTH CLIs need
 * it: `--round 1` has to mean round-1 on the way out and on the way back. The apply CLI
 * importing it from the packaging CLI would drag book.config.js and glob -- neither of
 * which apply uses -- into apply's require graph, so a broken book config would fail an
 * apply run for no reason.
 */
function resolveLabel(requested, existingTags) {
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    const raw = String(requested).trim();
    if (/^\d+$/.test(raw)) return `round-${raw}`;
    const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new Error(`--round "${raw}" contains no usable characters`);
    return slug;
  }
  const used = existingTags
    .map((tag) => tag.match(/^publisher\/round-(\d+)$/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return `round-${used.length ? Math.max(...used) + 1 : 1}`;
}

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

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * QUERIES.md gives editorial questions an outlet, so they do not get written inline
 * into the prose as HTML comments or parenthetical notes.
 *
 * The template lives here rather than in package-for-publisher.js because countQueries
 * below has to recognise it: the apply step warns "the publisher left queries", and a
 * warning that also fires on the untouched template we shipped is not a signal.
 */
/**
 * Every line here must be a complete line of the rendered template, because
 * countQueries matches them whole. A worked example is included: editors follow an
 * example far more reliably than an instruction, and a bare `- ` leaves them to guess
 * what "name the file and quote a phrase" is supposed to look like. The example is
 * boilerplate too, so leaving it in place does not read as a query.
 */
const QUERIES_BOILERPLATE = Object.freeze([
  'List anything you want the author to answer or decide.',
  'One query per bullet: name the file and quote a phrase so it can be found, like this:',
  '- ch3.md — "constellation of existing, trusted components": is this defined before here?',
  'Replace that example with your own, or delete it if you have no queries.',
]);

function renderQueries(label) {
  const [intro, howTo, example, closing] = QUERIES_BOILERPLATE;
  return `# Queries — ${label}\n\n${intro}\n${howTo}\n\n${example}\n\n${closing}\n\n- \n`;
}

/**
 * Count what the publisher actually wrote: filled-in bullets first, since that is the
 * shape the template asks for, and any other prose they left behind second, since a
 * publisher who ignores the bullet format still has queries worth reading.
 *
 * Everything the template itself contains -- its heading, its two instruction lines,
 * and its one empty bullet -- counts as nothing.
 */
function countQueries(text) {
  const boilerplate = new Set(QUERIES_BOILERPLATE);
  let count = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;          // the heading we shipped
    if (boilerplate.has(line)) continue;         // the instructions we shipped
    if (/^[-*+]$/.test(line)) continue;          // the empty bullet we shipped
    count++;                                     // a filled-in bullet, or free prose
  }
  return count;
}

/**
 * CHANGES.md tells the publisher what moved since the round they last read.
 *
 * WHY IT EXISTS. Rounds are incremental: the publisher has already copy-edited everything
 * in the bundle except the parts that changed after they saw it. Round 8 sent back four
 * chapters with small edits and a brand-new appendix, and nothing in the package said so —
 * so the only ways to find them were to re-read 256 pages or to diff two zips by hand.
 * Text nobody flags is text nobody edits: Appendix C and two new passages in chapter 9 had
 * never been read by an editor at all.
 *
 * WHY LINE DIFFS AND NOT paragraphBlocks(). These files are written one paragraph per line
 * (the README asks the publisher to keep them that way), so a changed line IS a changed
 * paragraph. paragraphBlocks() is the wrong tool here despite being right next door: it
 * only reports blocks at divDepth 0, so every word inside a `:::` callout is invisible to
 * it — and callout text is prose the publisher edits. Round 8's chapter 4 edit was inside
 * a promptref box and would have been reported as "no prose change".
 *
 * A REWORDED paragraph shows up as one removal and one addition rather than as an edit.
 * That is deliberate: pairing them means guessing which removal goes with which addition,
 * and a wrong guess prints a confident, false "changed from X to Y". Two honest lists beat
 * one clever one.
 *
 * Structural lines are dropped because they are not the publisher's to edit and listing
 * them buries the prose: fences, image references, and anything inside a code block.
 */
function isStructuralLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith(':::')) return true;            // callout fences
  // An image reference ALONE on its line is structural. One with prose after it is not:
  // ch6.md had an image and a paragraph sharing a line (which is also why it rendered as
  // an inline image with no caption), and matching on the prefix alone hid that paragraph
  // from this diff entirely -- the edit showed as an addition with no matching removal.
  if (/^!\[[^\]]*\]\([^)]*\)\s*(\{[^}]*\})?$/.test(t)) return true;
  return false;
}

/** Prose lines of a file, with code blocks removed. */
function proseLines(text) {
  const out = [];
  let inFence = false;
  for (const raw of String(text).split('\n')) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (isStructuralLine(raw)) continue;
    out.push(raw.trim());
  }
  return out;
}

/** Added and removed prose lines between two versions of one file. */
function proseDelta(prevText, curText) {
  const before = proseLines(prevText);
  const after = proseLines(curText);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((l) => !beforeSet.has(l)),
    removed: before.filter((l) => !afterSet.has(l)),
  };
}

/** One quoted excerpt, short enough to scan and long enough to find in the file. */
function quoteLine(line, max = 160) {
  const t = collapse(line);
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

/**
 * @param {string} label         this round, e.g. "round-8"
 * @param {string|null} prevLabel the round being compared against, or null if none
 * @param {Array<{name,prevText,curText}>} entries prevText is null for a new file
 */
function renderChanges({ label, prevLabel, entries }) {
  const head = `# What changed — ${label}\n\n`;
  if (!prevLabel) {
    return head + 'This is the first round, so everything in the package is new.\n';
  }

  const New = entries.filter((e) => e.prevText === null);
  const scored = entries
    .filter((e) => e.prevText !== null)
    .map((e) => ({ name: e.name, ...proseDelta(e.prevText, e.curText) }));
  const edited = scored.filter((e) => e.added.length || e.removed.length);
  const clean = scored.filter((e) => !e.added.length && !e.removed.length);

  let out = head +
    `Everything here was last sent as **${prevLabel}**. This note lists only what is\n` +
    `different since then, so you can go straight to it rather than re-reading the book.\n\n` +
    `Paragraphs are listed as removed and added separately. A reworded paragraph therefore\n` +
    `appears twice — once in each list — rather than as a before/after pair.\n\n`;

  if (New.length) {
    out += `## New files — never copy-edited\n\n` +
      `These have had no editorial pass at all. They are the priority.\n\n`;
    for (const e of New) {
      out += `- **${e.name}** — new in ${label}, ${proseLines(e.curText).length} paragraphs.\n`;
    }
    out += '\n';
  }

  if (edited.length) {
    out += `## Changed prose\n\n`;
    for (const e of edited) {
      out += `### ${e.name}\n\n`;
      if (e.removed.length) {
        out += `Removed (${e.removed.length}):\n\n`;
        for (const l of e.removed) out += `- ~~${quoteLine(l)}~~\n`;
        out += '\n';
      }
      if (e.added.length) {
        out += `Added (${e.added.length}):\n\n`;
        for (const l of e.added) out += `- ${quoteLine(l)}\n`;
        out += '\n';
      }
    }
  }

  if (clean.length) {
    out += `## Unchanged since ${prevLabel}\n\n` +
      clean.map((e) => e.name).join(', ') + '\n\n' +
      `Your edits to these were already applied, or you had none. No need to re-read them.\n`;
  }
  return out;
}

/**
 * MANIFEST.TXT is plain text so the publisher can read it, and so a human can tell at
 * a glance which round a returned bundle belongs to.
 *
 * Git is the merge anchor; this file exists to prove provenance and to catch files
 * added, removed, or renamed before the merge ever sees them.
 */
function renderManifest({ label, tag, commit, date, files }) {
  return [
    'Constellize book - publisher package',
    '',
    `Round:  ${label}`,
    `Tag:    ${tag}`,
    `Commit: ${commit}`,
    `Packed: ${date}`,
    '',
    'Do not edit this file. It is how the apply step identifies this round.',
    '',
    'sha256 of each file as sent:',
    '',
    ...files.map((f) => `${f.sha256}  ${f.name}`),
    '',
  ].join('\n');
}

function parseManifest(text) {
  const field = (name) => {
    const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };

  const label = field('Round');
  const tag = field('Tag');
  const commit = field('Commit');
  const date = field('Packed');

  if (!label) throw new Error('MANIFEST.TXT has no Round line');
  if (!tag) throw new Error('MANIFEST.TXT has no Tag line');
  if (!commit) throw new Error('MANIFEST.TXT has no Commit line');
  if (!date) throw new Error('MANIFEST.TXT has no Packed line');

  const files = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s\s(.+)$/);
    if (m) files.push({ name: m[2].trim(), sha256: m[1] });
  }
  if (!files.length) throw new Error('MANIFEST.TXT lists no files');

  return { label, tag, commit, date, files };
}

/** Compare the manifest against SNAPSHOT content, never against returned content. */
function verifyManifest(manifest, contentsByName) {
  const problems = [];
  for (const entry of manifest.files) {
    const content = contentsByName[entry.name];
    if (content === undefined) {
      problems.push(`${entry.name}: listed in MANIFEST.TXT but not found`);
      continue;
    }
    if (sha256(content) !== entry.sha256) {
      problems.push(`${entry.name}: content does not match the hash recorded in MANIFEST.TXT`);
    }
  }
  const listed = new Set(manifest.files.map((f) => f.name));
  for (const name of Object.keys(contentsByName)) {
    if (!listed.has(name)) problems.push(`${name}: present but not listed in MANIFEST.TXT`);
  }
  return problems;
}

/** Prerequisite check, in the spirit of build-book.js checking for pandoc. */
function assertArchiveTools() {
  for (const tool of ['zip', 'unzip']) {
    try {
      execFileSync(tool, ['-v'], { stdio: 'ignore' });
    } catch (err) {
      throw new Error(`${tool} is not available on PATH. Install it to package or apply publisher bundles.`);
    }
  }
}

function zipDir(parentDir, dirName, zipPath) {
  execFileSync('zip', ['-q', '-r', path.resolve(zipPath), dirName], { cwd: parentDir });
}

function unzipTo(zipPath, destDir) {
  execFileSync('unzip', ['-q', '-o', path.resolve(zipPath), '-d', path.resolve(destDir)]);
}

module.exports = {
  EXPECTED_FILES, BUNDLE_META_FILES, resolveLabel,
  normalizeBuffer, readAndNormalize, dewrapParagraphs,
  sha256, renderManifest, parseManifest, verifyManifest,
  renderQueries, countQueries, renderChanges, proseLines, proseDelta,
  assertArchiveTools, zipDir, unzipTo,
};
