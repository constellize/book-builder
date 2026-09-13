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

module.exports = { KIND, tokenize, fingerprint };
