'use strict';

/**
 * Structural guard for publisher round-trips.
 *
 * Every rule except code-fence-integrity runs on the tokenizer below rather than a
 * regex sweep over raw text, and the sources are why: a bare `^# ` match across the
 * 13 chapter files finds 69 lines, of which 57 are `#` comments inside shell and
 * Python samples. The real H1 count is 12. A regex-based guard would be dominated by
 * noise from code blocks.
 */

const KIND = Object.freeze({
  CODE_FENCE: 'code-fence',
  CODE: 'code',
  DIV_FENCE: 'div-fence',
  HEADING: 'heading',
  TABLE: 'table',
  LIST: 'list',
  BLANK: 'blank',
  TEXT: 'text',
});

function nextNonBlank(raw, from) {
  for (let i = from; i < raw.length; i++) {
    if (raw[i].trim() !== '') return raw[i];
  }
  return null;
}

/**
 * Classify every line. Single pass, no lookbehind beyond the running flags.
 *
 * Code fences toggle on any line whose trimmed form starts with ``` or ~~~. That is
 * deliberately simpler than CommonMark's fence-length matching: the 13 sources use
 * balanced three-backtick fences throughout (64 fence lines, 32 blocks), and a
 * toggle is predictable to reason about when a publisher breaks one.
 */
function tokenize(text) {
  const raw = text.split('\n');
  const lines = [];
  let inCode = false;
  let inList = false;
  let divDepth = 0;

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const trimmed = line.trim();
    let kind;

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      kind = KIND.CODE_FENCE;
      inCode = !inCode;
      inList = false;
    } else if (inCode) {
      kind = KIND.CODE;
    } else if (trimmed === '') {
      kind = KIND.BLANK;
      if (inList) {
        const next = nextNonBlank(raw, i + 1);
        if (next === null || !/^\s{2,}\S/.test(next)) inList = false;
      }
    } else if (trimmed.startsWith(':::')) {
      kind = KIND.DIV_FENCE;
      inList = false;
      if (/^:+$/.test(trimmed)) divDepth = Math.max(0, divDepth - 1);
      else divDepth += 1;
    } else if (/^#{1,6}\s/.test(line)) {
      kind = KIND.HEADING;
      inList = false;
    } else if (/^\s*\|/.test(line)) {
      kind = KIND.TABLE;
      inList = false;
    } else if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) {
      kind = KIND.LIST;
      inList = true;
    } else if (inList && /^\s{2,}\S/.test(line)) {
      kind = KIND.LIST;
    } else if (/^\s{4,}\S/.test(line)) {
      kind = KIND.CODE; // indented code block
    } else {
      kind = KIND.TEXT;
    }

    lines.push({ n: i + 1, raw: line, kind, divDepth });
  }

  return { lines };
}

const PLACEHOLDER_RE = /\{SITE_BASE\}|\{CODEPROMPTU_REPO_BASE\}/g;
const TEMPLATE_VAR_RE = /\{\{[^}\n]*\}\}/g;
const ATTR_BLOCK_RE = /\{[#.][^}\n]*\}/g;
const IMAGE_RE = /!\[[^\]\n]*\]\(([^)\s]+)/g;
const BRACKET_SPAN_RE = /\[[^\]\n]*\]/g;
const CITE_KEY_RE = /@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*)/g;

function bump(counter, tokens) {
  if (!tokens) return;
  for (const token of tokens) counter[token] = (counter[token] || 0) + 1;
}

/**
 * Reduce a file to the structural facts the guard compares.
 *
 * Div fence lines are captured verbatim and deliberately excluded from attrBlocks:
 * `::: {.promptref title="…" url="{SITE_BASE}/…"}` nests a brace pair inside its
 * attribute, so ATTR_BLOCK_RE truncates it at the inner `}`. Comparing the whole
 * fence line is both simpler and stricter.
 */
function fingerprint(text) {
  const { lines } = tokenize(text);
  const fp = {
    divFences: [],
    codeFences: [],
    placeholders: {},
    templateVars: {},
    attrBlocks: {},
    imagePaths: {},
    citations: {},
    headingLevels: [],
    codeBlocks: [],
    lineCount: lines.length,
  };

  let currentBlock = null;

  for (const line of lines) {
    if (line.kind === KIND.CODE_FENCE) {
      fp.codeFences.push(line.raw.trim());
      if (currentBlock === null) {
        currentBlock = [];
      } else {
        fp.codeBlocks.push(currentBlock.join('\n'));
        currentBlock = null;
      }
      continue;
    }

    if (line.kind === KIND.CODE) {
      if (currentBlock !== null) currentBlock.push(line.raw);
      continue; // indented code is excluded from every token scan
    }

    if (line.kind === KIND.DIV_FENCE) {
      fp.divFences.push(line.raw.trim());
      bump(fp.placeholders, line.raw.match(PLACEHOLDER_RE));
      continue;
    }

    if (line.kind === KIND.HEADING) {
      fp.headingLevels.push(line.raw.match(/^#+/)[0].length);
    }

    bump(fp.placeholders, line.raw.match(PLACEHOLDER_RE));
    bump(fp.templateVars, line.raw.match(TEMPLATE_VAR_RE));
    bump(fp.attrBlocks, line.raw.match(ATTR_BLOCK_RE));

    for (const m of line.raw.matchAll(IMAGE_RE)) bump(fp.imagePaths, [m[1]]);

    for (const span of line.raw.match(BRACKET_SPAN_RE) || []) {
      if (!span.includes('@')) continue;
      for (const m of span.matchAll(CITE_KEY_RE)) bump(fp.citations, [m[1]]);
    }
  }

  // An unterminated fence leaves a dangling block. Keep it so code-content can still
  // report; code-fence-integrity is what flags the imbalance itself.
  if (currentBlock !== null) fp.codeBlocks.push(currentBlock.join('\n'));

  return fp;
}

const RULES = Object.freeze({
  'file-set': 'error',
  encoding: 'error',
  'fence-integrity': 'error',
  'code-fence-integrity': 'error',
  'placeholder-tokens': 'error',
  'template-vars': 'error',
  'attr-blocks': 'error',
  'image-paths': 'error',
  citations: 'error',
  'heading-structure': 'warning',
  'code-content': 'warning',
  'change-volume': 'warning',
  'line-endings': 'warning',
});

// Bundle files that are metadata, not book sources.
const BUNDLE_META_FILES = new Set(['README.md', 'MANIFEST.TXT', 'QUERIES.md']);

const CHANGE_VOLUME_THRESHOLD = 0.4;

function counterDiff(before, after) {
  const out = [];
  for (const token of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[token] || 0;
    const to = after[token] || 0;
    if (from !== to) out.push({ token, from, to });
  }
  return out.sort((a, b) => a.token.localeCompare(b.token));
}

function describeCounterDiff(diff) {
  return diff
    .map(({ token, from, to }) =>
      to === 0 ? `removed ${token} (was ×${from})`
        : from === 0 ? `added ${token} (now ×${to})`
          : `${token} count changed ${from} → ${to}`)
    .join('; ');
}

function sequenceDiff(before, after) {
  const limit = Math.max(before.length, after.length);
  for (let i = 0; i < limit; i++) {
    if (before[i] !== after[i]) {
      return { index: i, before: before[i], after: after[i] };
    }
  }
  return null;
}

function changedLineFraction(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const common = new Set(a);
  let changed = 0;
  for (const line of b) if (!common.has(line)) changed++;
  const denominator = Math.max(a.length, b.length, 1);
  return changed / denominator;
}

/**
 * Compare one returned file against its snapshot.
 *
 * `notes` comes from publisher-bundle.readAndNormalize. Invalid UTF-8 short-circuits
 * everything: the text we would compare is already mojibake, so downstream findings
 * would be noise built on noise.
 */
function compareFiles({ name, snapshotText, returnedText, notes = {}, refKeys = null }) {
  const findings = [];
  const add = (rule, message, detail) =>
    findings.push({ file: name, rule, severity: RULES[rule], message, detail });

  if (notes.invalidUtf8) {
    add('encoding', 'File is not valid UTF-8; no further checks were run');
    return findings;
  }

  const before = fingerprint(snapshotText);
  const after = fingerprint(returnedText);

  const fenceDiff = sequenceDiff(before.divFences, after.divFences);
  if (fenceDiff) {
    add('fence-integrity',
      `::: fence #${fenceDiff.index + 1} changed`,
      `was: ${fenceDiff.before === undefined ? '(absent)' : fenceDiff.before}\nnow: ${fenceDiff.after === undefined ? '(absent)' : fenceDiff.after}`);
  } else if (before.divFences.length !== after.divFences.length) {
    add('fence-integrity',
      `::: fence count changed ${before.divFences.length} → ${after.divFences.length}`);
  }
  if (after.divFences.length % 2 !== 0) {
    add('fence-integrity', `::: fences do not balance (${after.divFences.length} fence lines)`);
  }

  const codeFenceDiff = sequenceDiff(before.codeFences, after.codeFences);
  if (codeFenceDiff) {
    add('code-fence-integrity',
      `code fence #${codeFenceDiff.index + 1} changed`,
      `was: ${codeFenceDiff.before === undefined ? '(absent)' : codeFenceDiff.before}\nnow: ${codeFenceDiff.after === undefined ? '(absent)' : codeFenceDiff.after}`);
  }
  if (after.codeFences.length % 2 !== 0) {
    add('code-fence-integrity', `code fences do not balance (${after.codeFences.length} fence lines)`);
  }

  for (const [rule, key] of [
    ['placeholder-tokens', 'placeholders'],
    ['template-vars', 'templateVars'],
    ['attr-blocks', 'attrBlocks'],
    ['image-paths', 'imagePaths'],
    ['citations', 'citations'],
  ]) {
    const diff = counterDiff(before[key], after[key]);
    if (diff.length) add(rule, describeCounterDiff(diff));
  }

  if (refKeys) {
    const unresolved = Object.keys(after.citations).filter((k) => !refKeys.has(k)).sort();
    if (unresolved.length) {
      add('citations', `citation key(s) not present in references.json: ${unresolved.join(', ')}`);
    }
  }

  if (before.headingLevels.join(',') !== after.headingLevels.join(',')) {
    add('heading-structure',
      `heading level sequence changed`,
      `was: ${before.headingLevels.join(' ')}\nnow: ${after.headingLevels.join(' ')}`);
  }

  const blockCount = Math.max(before.codeBlocks.length, after.codeBlocks.length);
  for (let i = 0; i < blockCount; i++) {
    if (before.codeBlocks[i] !== after.codeBlocks[i]) {
      add('code-content',
        `code block #${i + 1} content changed`,
        `was:\n${before.codeBlocks[i] ?? '(absent)'}\n\nnow:\n${after.codeBlocks[i] ?? '(absent)'}`);
    }
  }

  if (notes.hadBom || notes.hadCrlf || notes.addedTrailingNewline) {
    const what = [
      notes.hadBom && 'stripped a UTF-8 BOM',
      notes.hadCrlf && 'converted CRLF to LF',
      notes.addedTrailingNewline && 'added a trailing newline',
    ].filter(Boolean).join(', ');
    add('line-endings', `normalization ${what}`);
  }

  const fraction = changedLineFraction(snapshotText, returnedText);
  if (fraction > CHANGE_VOLUME_THRESHOLD) {
    add('change-volume', `${Math.round(fraction * 100)}% of lines differ from the snapshot`);
  }

  return findings;
}

function checkFileSet(expected, actual) {
  const present = new Set(actual.filter((f) => !BUNDLE_META_FILES.has(f)));
  const wanted = new Set(expected);
  const missing = expected.filter((f) => !present.has(f));
  const extra = [...present].filter((f) => !wanted.has(f)).sort();

  const findings = [];
  if (missing.length) {
    findings.push({ file: '(bundle)', rule: 'file-set', severity: RULES['file-set'],
      message: `missing file(s): ${missing.join(', ')}` });
  }
  if (extra.length) {
    findings.push({ file: '(bundle)', rule: 'file-set', severity: RULES['file-set'],
      message: `unexpected file(s): ${extra.join(', ')}` });
  }
  return findings;
}

function hasErrors(findings) {
  return findings.some((x) => x.severity === 'error');
}

function renderReport(findings) {
  if (!findings.length) {
    return '# Publisher guard report\n\nNo structural changes detected. Every build-only construct is intact.\n';
  }

  const byFile = new Map();
  for (const finding of findings) {
    if (!byFile.has(finding.file)) byFile.set(finding.file, []);
    byFile.get(finding.file).push(finding);
  }

  const out = ['# Publisher guard report', '', '| File | Errors | Warnings |', '| --- | --- | --- |'];
  for (const [file, list] of byFile) {
    const errors = list.filter((x) => x.severity === 'error').length;
    const warnings = list.length - errors;
    out.push(`| ${file} | ${errors} | ${warnings} |`);
  }
  out.push('');

  for (const [file, list] of byFile) {
    out.push(`## ${file}`, '');
    for (const finding of list) {
      out.push(`- **${finding.severity}** \`${finding.rule}\` — ${finding.message}`);
      if (finding.detail) {
        out.push('', '  ```', ...finding.detail.split('\n').map((l) => '  ' + l), '  ```');
      }
    }
    out.push('');
  }

  return out.join('\n');
}

module.exports = {
  KIND, tokenize, fingerprint, RULES, BUNDLE_META_FILES,
  compareFiles, checkFileSet, hasErrors, renderReport,
};
