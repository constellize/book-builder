#!/usr/bin/env node

/**
 * build-reference-docx.js — generate the pandoc `--reference-doc` files.
 *
 *     node scripts/build-reference-docx.js --variant both
 *
 * Produces, for each variant:
 *     templates/docx/reference-<variant>.docx   the artefact pandoc consumes
 *     templates/docx/src-<variant>/             the unzipped XML, byte-identical
 *
 * The `src-` directory is not a by-product: the docx is zipped FROM it, so the
 * two can never disagree. A .docx is an opaque binary to git; this is what makes
 * a style change reviewable in a pull request.
 *
 * ---------------------------------------------------------------------------
 * PIPELINE
 * ---------------------------------------------------------------------------
 *   1. `pandoc --print-default-data-file reference.docx` for the baseline.
 *      Pinned to the installed pandoc rather than vendored as a blob, so the
 *      baseline can never drift from the pandoc actually doing the conversion.
 *   2. Unzip, then apply the declarative patch from config/docx-styles.js:
 *      styles.xml, theme1.xml, settings.xml, document.xml (sectPr),
 *      header/footer parts, their rels, and [Content_Types].xml.
 *   3. Plant embedded font parts via scripts/lib/font-embed.js.
 *   4. Re-zip with `zip -r -X`.
 *
 * ---------------------------------------------------------------------------
 * WHY SCHEMA-ORDER NORMALISATION (the least obvious part of this file)
 * ---------------------------------------------------------------------------
 * OOXML complex types are *ordered sequences*, not bags. `<w:ind>` before
 * `<w:spacing>` inside `<w:pPr>` is invalid, and the failure mode is silence:
 * Word ignores the offending element, or the whole part, with no diagnostic.
 * Rather than trust every hand-written fragment to be in schema order, every
 * pPr / rPr / style block is rebuilt through ORDER tables below. Getting a
 * fragment "wrong" in the config is therefore harmless.
 *
 * Element-level replacement (not attribute merging) is also load-bearing.
 * pandoc's baseline writes fonts as `w:asciiTheme="minorHAnsi"` and colours as
 * `w:themeColor="accent1"`; both theme attributes WIN over an explicit
 * `w:ascii` / `w:val` sitting beside them. Swapping the whole element out is the
 * only thing that actually removes them.
 */

'use strict';

const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const chalk = require('chalk');
const { Command } = require('commander');

const styleSpec = require('../config/docx-styles.js');
const fontEmbed = require('./lib/font-embed.js');

const ROOT = path.resolve(__dirname, '..');
const FONTS_DIR = path.join(ROOT, 'fonts');
const OUT_DIR = path.join(ROOT, 'templates', 'docx');

/** Fixed timestamp so rebuilds from unchanged inputs are byte-identical. */
const EPOCH = new Date('2020-01-01T00:00:00Z');

/**
 * Relationship id base for header/footer parts.
 *
 * Ids are allocated sequentially across headers then footers, so the set grows
 * downwards from here as parts are added (today: rId901-903 headers,
 * rId904-906 footers). 901 is far above anything pandoc's baseline
 * reference.docx uses (rId1-rId8 plus a rId30 sample hyperlink), so a new part
 * can never collide with a baseline relationship — and `addRelationships`
 * deletes any same-Id relationship before writing, so it cannot collide with a
 * previous run either.
 */
const HF_REL_BASE = 901;

const REL_TYPES = {
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
};
const CONTENT_TYPES = {
  header: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  footer: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
};

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// ===========================================================================
// Schema order tables (ECMA-376 Part 1)
// ===========================================================================

/** CT_RPr / EG_RPrBase child order. */
const RPR_ORDER = [
  'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps',
  'w:strike', 'w:dstrike', 'w:outline', 'w:shadow', 'w:emboss', 'w:imprint',
  'w:noProof', 'w:snapToGrid', 'w:vanish', 'w:webHidden', 'w:color', 'w:spacing',
  'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs', 'w:highlight', 'w:u', 'w:effect',
  'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang',
  'w:eastAsianLayout', 'w:specVanish', 'w:oMath',
];

/** CT_PPr / CT_PPrBase child order. */
const PPR_ORDER = [
  'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr',
  'w:widowControl', 'w:numPr', 'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs',
  'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap', 'w:overflowPunct',
  'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd',
  'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents',
  'w:suppressOverlap', 'w:jc', 'w:textDirection', 'w:textAlignment',
  'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle', 'w:rPr', 'w:sectPr',
  'w:pPrChange',
];

/** CT_Style child order. */
const STYLE_ORDER = [
  'w:name', 'w:aliases', 'w:basedOn', 'w:next', 'w:link', 'w:autoRedefine',
  'w:hidden', 'w:uiPriority', 'w:semiHidden', 'w:unhideWhenUsed', 'w:qFormat',
  'w:locked', 'w:personal', 'w:personalCompose', 'w:personalReply', 'w:rsid',
  'w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr', 'w:tcPr', 'w:tblStylePr',
];

/** CT_SectPr child order (the subset this generator emits). */
const SECTPR_ORDER = [
  'w:headerReference', 'w:footerReference', 'w:footnotePr', 'w:endnotePr', 'w:type',
  'w:pgSz', 'w:pgMar', 'w:paperSrc', 'w:pgBorders', 'w:lnNumType', 'w:pgNumType',
  'w:cols', 'w:formProt', 'w:vAlign', 'w:noEndnote', 'w:titlePg', 'w:textDirection',
  'w:bidi', 'w:rtlGutter', 'w:docGrid',
];

// ===========================================================================
// Minimal XML fragment tools
// ===========================================================================

/**
 * Read a start/empty tag beginning at `pos`, respecting quoted attribute values.
 * @param {string} xml
 * @param {number} pos index of '<'
 * @returns {{name: string, selfClosing: boolean, end: number}} `end` is just past '>'
 */
function parseTag(xml, pos) {
  let i = pos + 1;
  const nameStart = i;
  while (i < xml.length && !/[\s/>]/.test(xml[i])) i++;
  const name = xml.slice(nameStart, i);
  let quote = null;
  while (i < xml.length) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      const selfClosing = xml[i - 1] === '/';
      return { name, selfClosing, end: i + 1 };
    }
    i++;
  }
  throw new Error(`build-reference-docx: unterminated tag at offset ${pos}`);
}

/**
 * Split an XML fragment into its top-level elements, preserving nesting.
 * Text between elements (whitespace in these element-only contexts) is dropped.
 *
 * @param {string} xml
 * @returns {Array<{tag: string, xml: string}>}
 */
function splitElements(xml) {
  const out = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    // Skip comments and processing instructions.
    if (xml.startsWith('<!--', lt)) {
      i = xml.indexOf('-->', lt) + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      i = xml.indexOf('?>', lt) + 2;
      continue;
    }
    const tag = parseTag(xml, lt);
    if (tag.selfClosing) {
      out.push({ tag: tag.name, xml: xml.slice(lt, tag.end) });
      i = tag.end;
      continue;
    }
    let depth = 1;
    let j = tag.end;
    while (depth > 0) {
      const next = xml.indexOf('<', j);
      if (next === -1) {
        throw new Error(`build-reference-docx: unclosed <${tag.name}>`);
      }
      if (xml[next + 1] === '/') {
        const gt = xml.indexOf('>', next);
        if (gt === -1) throw new Error('build-reference-docx: unterminated end tag');
        depth--;
        j = gt + 1;
      } else if (xml.startsWith('<!--', next)) {
        j = xml.indexOf('-->', next) + 3;
      } else {
        const inner = parseTag(xml, next);
        if (!inner.selfClosing) depth++;
        j = inner.end;
      }
    }
    out.push({ tag: tag.name, xml: xml.slice(lt, j) });
    i = j;
  }
  return out;
}

/**
 * Merge two element lists and emit them in schema order.
 *
 * Patch elements REPLACE existing elements of the same tag outright — that is
 * what strips `w:asciiTheme` from `w:rFonts` and `w:themeColor` from `w:color`.
 * Elements only present in `existing` are kept.
 *
 * @param {string} existing XML fragment (may be empty)
 * @param {string} patch XML fragment (may be empty)
 * @param {string[]} order canonical child order
 * @returns {string} merged fragment in schema order
 * @throws {Error} if either side contains an element absent from `order`
 */
function mergeOrdered(existing, patch, order) {
  const byTag = new Map();
  for (const el of splitElements(existing || '')) byTag.set(el.tag, el.xml);
  for (const el of splitElements(patch || '')) byTag.set(el.tag, el.xml);

  const rank = new Map(order.map((t, idx) => [t, idx]));
  for (const tag of byTag.keys()) {
    if (!rank.has(tag)) {
      // Fail loudly: an unknown element means either a typo in the config or a
      // schema table that has fallen behind. Emitting it in an arbitrary
      // position would produce a file Word rejects without explanation.
      throw new Error(
        `build-reference-docx: <${tag}> is not in the known child order ` +
          `[${order.slice(0, 6).join(', ')} ...]. Add it to the ORDER table.`
      );
    }
  }
  return [...byTag.entries()]
    .sort((a, b) => rank.get(a[0]) - rank.get(b[0]))
    .map(([, xml]) => xml)
    .join('');
}

/**
 * Return the inner XML of the first `<tag>...</tag>` in `xml`, or null.
 * @param {string} xml
 * @param {string} tag
 * @returns {{inner: string, start: number, end: number}|null}
 */
function findElement(xml, tag) {
  const re = new RegExp(`<${tag}(\\s[^>]*)?(/)?>`);
  const m = re.exec(xml);
  if (!m) return null;
  const openEnd = m.index + m[0].length;
  if (m[2]) return { inner: '', start: m.index, end: openEnd }; // self-closing
  const close = `</${tag}>`;
  const closeAt = xml.indexOf(close, openEnd);
  if (closeAt === -1) {
    throw new Error(`build-reference-docx: <${tag}> is never closed`);
  }
  return { inner: xml.slice(openEnd, closeAt), start: m.index, end: closeAt + close.length };
}

/**
 * Insert `fragment` immediately before or after a sibling element, keeping
 * CT_Settings-style ordered sequences valid. Idempotent: a fragment whose tag
 * is already present is skipped.
 *
 * @param {string} xml
 * @param {{xml: string, before?: string, after?: string}} rule
 * @returns {string}
 * @throws {Error} if the anchor element is missing
 */
function insertRelative(xml, rule) {
  const tagName = /^<([A-Za-z0-9:]+)/.exec(rule.xml)[1];
  if (new RegExp(`<${tagName}[\\s/>]`).test(xml)) return xml; // already present
  const anchor = rule.before || rule.after;
  const re = new RegExp(`<${anchor}(\\s[^>]*)?/>|<${anchor}(\\s[^>]*)?>[\\s\\S]*?</${anchor}>`);
  const m = re.exec(xml);
  if (!m) {
    throw new Error(
      `build-reference-docx: settings.xml anchor <${anchor}> not found; ` +
        `cannot place ${rule.xml} in schema order`
    );
  }
  return rule.before
    ? xml.slice(0, m.index) + rule.xml + xml.slice(m.index)
    : xml.slice(0, m.index + m[0].length) + rule.xml + xml.slice(m.index + m[0].length);
}

/** Escape a string for use in an XML attribute or text node. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===========================================================================
// styles.xml
// ===========================================================================

/**
 * Apply the declarative style patch to word/styles.xml.
 *
 * @param {string} xml current styles.xml
 * @param {object} spec resolved variant spec
 * @returns {{xml: string, replaced: string[], created: string[], patched: string[]}}
 * @throws {Error} if a `replace`/`patch` targets a style that does not exist
 */
function patchStyles(xml, spec) {
  let out = xml;
  const replaced = [];
  const created = [];
  const patched = [];

  // ---- docDefaults -------------------------------------------------------
  const defaults = findElement(out, 'w:docDefaults');
  if (!defaults) throw new Error('build-reference-docx: styles.xml has no <w:docDefaults>');
  let block = defaults.inner;

  const rprDefault = findElement(block, 'w:rPrDefault');
  if (!rprDefault) throw new Error('build-reference-docx: no <w:rPrDefault>');
  const rprInner = findElement(rprDefault.inner, 'w:rPr');
  const mergedRPr = mergeOrdered(rprInner ? rprInner.inner : '', spec.docDefaults.rPr, RPR_ORDER);
  block =
    block.slice(0, rprDefault.start) +
    `<w:rPrDefault><w:rPr>${mergedRPr}</w:rPr></w:rPrDefault>` +
    block.slice(rprDefault.end);

  const pprDefault = findElement(block, 'w:pPrDefault');
  if (!pprDefault) throw new Error('build-reference-docx: no <w:pPrDefault>');
  const pprInner = findElement(pprDefault.inner, 'w:pPr');
  const mergedPPr = mergeOrdered(pprInner ? pprInner.inner : '', spec.docDefaults.pPr, PPR_ORDER);
  block =
    block.slice(0, pprDefault.start) +
    `<w:pPrDefault><w:pPr>${mergedPPr}</w:pPr></w:pPrDefault>` +
    block.slice(pprDefault.end);

  out = out.slice(0, defaults.start) + `<w:docDefaults>${block}</w:docDefaults>` + out.slice(defaults.end);

  // ---- individual styles -------------------------------------------------
  for (const [styleId, patch] of Object.entries(spec.styles)) {
    const re = new RegExp(
      `<w:style\\s[^>]*w:styleId="${styleId}"[^>]*>[\\s\\S]*?</w:style>`
    );
    const m = re.exec(out);

    if (!m) {
      if (!patch.create) {
        // A replace/patch whose target vanished means pandoc's reference.docx
        // changed under us. Silently skipping is exactly how a style patch
        // stops working without anyone noticing.
        throw new Error(
          `build-reference-docx: style "${styleId}" is not in pandoc's reference.docx ` +
            `and is not marked { create: true }. pandoc ${pandocVersion()} may have ` +
            `changed its default styles.`
        );
      }
      const type = patch.type || 'paragraph';
      const body = mergeOrdered('', patch.body, STYLE_ORDER);
      const el = `<w:style w:type="${type}" w:customStyle="1" w:styleId="${styleId}">${body}</w:style>`;
      const close = out.lastIndexOf('</w:styles>');
      out = `${out.slice(0, close)}  ${el}\n${out.slice(close)}`;
      created.push(styleId);
      continue;
    }

    if (patch.create && !patch.replace) {
      // Present already (e.g. a future pandoc added it): treat create as replace
      // so the result is identical either way and the build stays idempotent.
      const attrs = /<w:style\s([^>]*)>/.exec(m[0])[1];
      const body = mergeOrdered('', patch.body, STYLE_ORDER);
      out = out.slice(0, m.index) + `<w:style ${attrs}>${body}</w:style>` + out.slice(m.index + m[0].length);
      replaced.push(styleId);
      continue;
    }

    const attrs = /<w:style\s([^>]*)>/.exec(m[0])[1];
    const inner = m[0].slice(m[0].indexOf('>') + 1, m[0].lastIndexOf('</w:style>'));

    let body;
    if (patch.replace) {
      body = mergeOrdered('', patch.body, STYLE_ORDER);
      replaced.push(styleId);
    } else {
      // Merge pPr / rPr element-by-element, keeping everything else.
      const existing = new Map(splitElements(inner).map((e) => [e.tag, e.xml]));
      if (patch.patchPPr !== undefined) {
        const cur = existing.get('w:pPr');
        const curInner = cur ? findElement(cur, 'w:pPr').inner : '';
        existing.set('w:pPr', `<w:pPr>${mergeOrdered(curInner, patch.patchPPr, PPR_ORDER)}</w:pPr>`);
      }
      if (patch.patchRPr !== undefined) {
        const cur = existing.get('w:rPr');
        const curInner = cur ? findElement(cur, 'w:rPr').inner : '';
        existing.set('w:rPr', `<w:rPr>${mergeOrdered(curInner, patch.patchRPr, RPR_ORDER)}</w:rPr>`);
      }
      body = mergeOrdered(
        [...existing.values()].join(''),
        '',
        STYLE_ORDER
      );
      patched.push(styleId);
    }

    out = out.slice(0, m.index) + `<w:style ${attrs}>${body}</w:style>` + out.slice(m.index + m[0].length);
  }

  return { xml: out, replaced, created, patched };
}

// ===========================================================================
// theme1.xml
// ===========================================================================

/**
 * Point the theme's major and minor latin typefaces at the book font.
 *
 * Mandatory: Word materialises TOC1..TOC9 from its own gallery when it updates
 * the TOC field, and those styles resolve their font through `minorHAnsi`.
 * Nothing in styles.xml can reach them.
 *
 * The `panose` attribute is dropped along with the typeface — a stale PANOSE
 * describing Aptos would drive font substitution for a completely different face.
 *
 * @param {string} xml theme1.xml
 * @param {object} spec resolved variant spec
 * @returns {string}
 * @throws {Error} if either font slot is missing
 */
function patchTheme(xml, spec) {
  let out = xml;
  for (const [slot, typeface] of [
    ['a:majorFont', spec.theme.majorLatin],
    ['a:minorFont', spec.theme.minorLatin],
  ]) {
    const el = findElement(out, slot);
    if (!el) throw new Error(`build-reference-docx: theme1.xml has no <${slot}>`);
    const latin = /<a:latin\s[^>]*\/>/.exec(el.inner);
    if (!latin) {
      throw new Error(`build-reference-docx: <${slot}> has no <a:latin> typeface`);
    }
    const newInner =
      el.inner.slice(0, latin.index) +
      `<a:latin typeface="${esc(typeface)}"/>` +
      el.inner.slice(latin.index + latin[0].length);
    out = out.slice(0, el.start) + `<${slot}>${newInner}</${slot}>` + out.slice(el.end);
  }
  return out;
}

// ===========================================================================
// header / footer parts
// ===========================================================================

/**
 * A Word field: begin / instrText / separate / cached result / end.
 * @param {{kind: string, styleName?: string}} field
 * @param {string} placeholder cached result shown until the field is refreshed
 * @returns {string} XML runs
 */
function fieldRuns(field, placeholder) {
  let instr;
  if (field.kind === 'page') {
    instr = ' PAGE \\* MERGEFORMAT ';
  } else if (field.kind === 'styleref') {
    // STYLEREF matches the style NAME (w:name), case-insensitively — not the
    // styleId. "Heading 1" is correct; "Heading1" silently finds nothing.
    instr = ` STYLEREF "${field.styleName}" \\* MERGEFORMAT `;
  } else {
    throw new Error(`build-reference-docx: unknown header field kind "${field.kind}"`);
  }
  return (
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve">${esc(instr)}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t>${esc(placeholder)}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  );
}

/**
 * Build one header or footer part.
 *
 * Three shapes, chosen by the descriptor in config/docx-styles.js:
 *
 *   { cells: [a, b] }   a borderless two-cell running head (see below)
 *   { paragraph: p }    a single aligned line — the `plain` centred folio
 *   { cells: null }     an explicitly EMPTY part
 *
 * The empty case is not the same as omitting the part. A `first` reference that
 * points at nothing makes Word fall back to the `default` part for that page,
 * which is the opposite of what titlePg is for; an explicit blank part is what
 * actually clears the running head on a chapter opening.
 *
 * A borderless two-cell fixed-layout TABLE is used for the running heads rather
 * than tab stops, and that is a correctness decision, not a style one. pandoc
 * emits a numbered heading as [SectionNumber "1.1"][<w:tab/>]["Title"], and
 * STYLEREF reproduces that embedded tab inside the header. With a tab-stop
 * layout the embedded tab consumes the header's own stops: the page number gets
 * torn away from the title, and a long verso heading overflows the page edge and
 * clips. Table cells are hard boundaries, so neither can happen. The
 * `w:tab w:pos="360"` inside each cell tames the embedded tab to a 0.25in gap.
 *
 * The `paragraph` shape deliberately does NOT use the table: a folio has one
 * field and no second column to be torn away from, and `w:jc="center"` on a
 * plain paragraph centres on the section's own margins — which mirrorMargins
 * shifts by the gutter, matching LaTeX's `\hfil\thepage\hfil` inside a
 * bindingoffset-shifted `\textwidth`. Centring inside a fixed-width table cell
 * would instead pin the folio to the paper, and the recto folios would sit
 * 14.4pt left of where the PDF puts them.
 *
 * @param {object} spec resolved variant spec
 * @param {{cells?: Array|null, paragraph?: object}} item part descriptor
 * @param {'header'|'footer'} kind
 * @returns {string} complete part XML
 * @throws {Error} if the descriptor asks for both layouts at once
 */
function buildHeaderFooterPart(spec, item, kind) {
  const root = kind === 'header' ? 'w:hdr' : 'w:ftr';
  const styleId = kind === 'header' ? 'Header' : 'Footer';
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const open = `<${root} xmlns:w="${W_NS}" xmlns:r="${R_NS}">`;

  const emptyPara = `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr></w:p>`;
  const { cells, paragraph } = item;

  if (cells && paragraph) {
    throw new Error(
      `build-reference-docx: ${item.file} declares both "cells" and "paragraph"; ` +
        'a part has one layout. Pick the table (two columns) or the single line.'
    );
  }

  if (paragraph) {
    // \thispagestyle{plain}: one centred field, no rule, no table.
    return (
      decl +
      open +
      '<w:p><w:pPr>' +
      `<w:pStyle w:val="${styleId}"/>` +
      '<w:spacing w:before="0" w:after="0"/>' +
      `<w:jc w:val="${paragraph.align}"/>` +
      '</w:pPr>' +
      fieldRuns(paragraph.field, paragraph.placeholder) +
      `</w:p></${root}>\n`
    );
  }

  if (!cells) {
    // \thispagestyle{empty}: an explicit empty part, so nothing is inherited.
    return `${decl}${open}${emptyPara}</${root}>\n`;
  }

  const widths = cells.map((c) =>
    c.field.kind === 'page' ? spec.headerColumns.pageNumber : spec.headerColumns.title
  );
  const rule = spec.headRuleSize;

  const cellXml = cells
    .map((cell, i) => {
      const w = widths[i];
      return (
        '<w:tc>' +
        `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>` +
        // The 0.4pt headrule from \renewcommand{\headrulewidth}{0.4pt}.
        `<w:tcBorders><w:bottom w:val="single" w:sz="${rule}" w:space="0" w:color="${spec.color.rule}"/></w:tcBorders>` +
        '<w:tcMar><w:left w:w="0" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>' +
        '</w:tcPr>' +
        '<w:p><w:pPr>' +
        `<w:pStyle w:val="${styleId}"/>` +
        '<w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs>' +
        '<w:spacing w:before="0" w:after="0"/>' +
        `<w:jc w:val="${cell.align}"/>` +
        '</w:pPr>' +
        fieldRuns(cell.field, cell.placeholder) +
        '</w:p>' +
        '</w:tc>'
      );
    })
    .join('\n   ');

  const total = widths.reduce((a, b) => a + b, 0);
  const noBorder = (side) =>
    `<w:${side} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`;

  return (
    decl +
    open +
    '\n <w:tbl>\n' +
    '  <w:tblPr>' +
    `<w:tblW w:w="${total}" w:type="dxa"/>` +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(noBorder).join('') +
    '</w:tblBorders>' +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>' +
    '</w:tblPr>\n' +
    `  <w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>\n` +
    `  <w:tr>\n   ${cellXml}\n  </w:tr>\n` +
    ' </w:tbl>\n' +
    // A table may not be the last block in a part, and this paragraph also
    // supplies the gap between the rule and the body text.
    ` <w:p><w:pPr><w:pStyle w:val="${styleId}"/>` +
    '<w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>\n' +
    `</${root}>\n`
  );
}

// ===========================================================================
// document.xml (sectPr)
// ===========================================================================

/**
 * Replace the reference document's sectPr with the target page geometry.
 *
 * pandoc copies this sectPr into its output verbatim (r:id values included),
 * which is the entire mechanism by which page size, margins and running heads
 * reach the converted book.
 *
 * @param {string} xml document.xml
 * @param {object} spec resolved variant spec
 * @param {Array<{type: string, relId: string, kind: string}>} refs header/footer refs
 * @returns {string}
 */
function patchDocument(xml, spec, refs) {
  const el = findElement(xml, 'w:sectPr');
  if (!el) throw new Error('build-reference-docx: document.xml has no <w:sectPr>');

  const headerRefs = refs
    .filter((r) => r.kind === 'header')
    .map((r) => `<w:headerReference w:type="${r.type}" r:id="${r.relId}"/>`)
    .join('');
  const footerRefs = refs
    .filter((r) => r.kind === 'footer')
    .map((r) => `<w:footerReference w:type="${r.type}" r:id="${r.relId}"/>`)
    .join('');

  const m = spec.margin;
  const body =
    headerRefs +
    footerRefs +
    // Preserved from the baseline: footnotes renumber per section.
    '<w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr>' +
    (spec.sectionType ? `<w:type w:val="${spec.sectionType}"/>` : '') +
    `<w:pgSz w:w="${spec.page.width}" w:h="${spec.page.height}"/>` +
    `<w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" w:left="${m}" ` +
    `w:header="${spec.headerFooterDist}" w:footer="${spec.headerFooterDist}" ` +
    `w:gutter="${spec.gutter}"/>` +
    '<w:pgNumType w:fmt="decimal"/>' +
    // Activates BOTH `first` parts — the blank header and the folio footer —
    // i.e. \thispagestyle{plain} on the opening page of every section.
    '<w:titlePg/>';

  const ordered = mergeOrderedSectPr(body);
  return xml.slice(0, el.start) + `<w:sectPr>${ordered}</w:sectPr>` + xml.slice(el.end);
}

/**
 * Order sectPr children, allowing repeats of headerReference / footerReference
 * (which mergeOrdered's tag-keyed map would collapse).
 * @param {string} fragment
 * @returns {string}
 */
function mergeOrderedSectPr(fragment) {
  const rank = new Map(SECTPR_ORDER.map((t, i) => [t, i]));
  const els = splitElements(fragment);
  for (const el of els) {
    if (!rank.has(el.tag)) {
      throw new Error(`build-reference-docx: <${el.tag}> is not a known sectPr child`);
    }
  }
  return els
    .map((el, i) => ({ el, i }))
    .sort((a, b) => rank.get(a.el.tag) - rank.get(b.el.tag) || a.i - b.i)
    .map(({ el }) => el.xml)
    .join('');
}

// ===========================================================================
// package plumbing
// ===========================================================================

/**
 * Add relationships to a .rels part, replacing any with the same Id.
 * @param {string} xml
 * @param {Array<{id: string, type: string, target: string}>} rels
 * @returns {string}
 */
function addRelationships(xml, rels) {
  let out = xml;
  for (const rel of rels) {
    out = out.replace(
      new RegExp(`<Relationship\\s[^>]*Id="${rel.id}"[^>]*/>`, 'g'),
      ''
    );
  }
  const additions = rels
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"/>`
    )
    .join('');
  const close = out.lastIndexOf('</Relationships>');
  if (close === -1) {
    throw new Error('build-reference-docx: rels part has no </Relationships>');
  }
  return out.slice(0, close) + additions + out.slice(close);
}

/**
 * Declare the header/footer Overrides and the obfuscated-font Default.
 *
 * pandoc REGENERATES [Content_Types].xml from its own template, so these
 * declarations do not survive into the converted book — pandoc re-derives them
 * (verified: it emits the header/footer Overrides for the parts it carries over,
 * and the odttf Default unconditionally). They are still required here so the
 * reference doc is itself a valid, openable docx.
 *
 * @param {string} xml
 * @param {Array<{part: string, kind: string}>} parts
 * @returns {string}
 */
function patchContentTypes(xml, parts) {
  let out = fontEmbed.injectContentTypeDefault(xml);
  const additions = parts
    .filter((p) => !out.includes(`PartName="/${p.part}"`))
    .map(
      (p) => `<Override PartName="/${p.part}" ContentType="${CONTENT_TYPES[p.kind]}"/>`
    )
    .join('');
  const close = out.lastIndexOf('</Types>');
  if (close === -1) throw new Error('build-reference-docx: [Content_Types].xml has no </Types>');
  return out.slice(0, close) + additions + out.slice(close);
}

// ===========================================================================
// helpers
// ===========================================================================

let _pandocVersion = null;
/** @returns {string} the installed pandoc version, e.g. "3.8.3" */
function pandocVersion() {
  if (_pandocVersion === null) {
    const out = execFileSync('pandoc', ['--version'], { encoding: 'utf8' });
    const m = /^pandoc(?:\.exe)?\s+([\d.]+)/m.exec(out);
    if (!m) throw new Error('build-reference-docx: could not parse `pandoc --version`');
    _pandocVersion = m[1];
  }
  return _pandocVersion;
}

/**
 * Extract pandoc's default reference.docx into `dest`.
 * @param {string} dest directory to populate
 */
function extractBaseline(dest) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refdocx-'));
  const blob = path.join(tmp, 'baseline.docx');
  try {
    const data = execFileSync('pandoc', ['--print-default-data-file', 'reference.docx'], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    });
    if (!data || data.length < 1024) {
      throw new Error(
        `build-reference-docx: pandoc returned ${data ? data.length : 0} bytes for ` +
          'reference.docx; expected a zip archive'
      );
    }
    fs.writeFileSync(blob, data);
    fs.emptyDirSync(dest);
    execFileSync('unzip', ['-q', blob, '-d', dest]);
  } finally {
    fs.removeSync(tmp);
  }
}

/**
 * Zip a directory into a .docx with stable bytes.
 * @param {string} srcDir
 * @param {string} outFile
 */
function zipDocx(srcDir, outFile) {
  fs.removeSync(outFile);
  // Normalise mtimes so an unchanged input yields an unchanged archive.
  for (const p of walk(srcDir)) fs.utimesSync(p, EPOCH, EPOCH);

  const entries = fs
    .readdirSync(srcDir)
    .filter((e) => e !== '[Content_Types].xml')
    .sort();
  // [Content_Types].xml conventionally leads the archive.
  execFileSync('zip', ['-q', '-r', '-X', outFile, '[Content_Types].xml', ...entries], {
    cwd: srcDir,
  });
}

/** Recursively list files and directories under `dir`. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    out.push(p);
    if (entry.isDirectory()) out.push(...walk(p));
  }
  return out;
}

/** Format a byte count. */
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

// ===========================================================================
// build
// ===========================================================================

/**
 * Build one reference document.
 * @param {'digital'|'print'} variantName
 * @returns {Promise<object>} a report for the console summary
 */
async function buildVariant(variantName) {
  const spec = styleSpec.resolve(variantName);
  const srcDir = path.join(OUT_DIR, `src-${variantName}`);
  const docxPath = path.join(OUT_DIR, `reference-${variantName}.docx`);

  console.log(chalk.blue(`\nBuilding reference-${variantName}.docx`));
  console.log(chalk.gray(`  ${spec.description}`));

  // 1. baseline ------------------------------------------------------------
  fs.ensureDirSync(OUT_DIR);
  extractBaseline(srcDir);
  console.log(chalk.gray(`  baseline from pandoc ${pandocVersion()}`));

  const read = (rel) => fs.readFileSync(path.join(srcDir, rel), 'utf8');
  const write = (rel, data) => {
    const p = path.join(srcDir, rel);
    fs.ensureDirSync(path.dirname(p));
    fs.writeFileSync(p, data);
  };

  // 2. styles.xml ----------------------------------------------------------
  const styleResult = patchStyles(read('word/styles.xml'), spec);
  write('word/styles.xml', styleResult.xml);
  console.log(
    chalk.gray(
      `  styles: ${styleResult.replaced.length} replaced, ` +
        `${styleResult.patched.length} patched, ${styleResult.created.length} created ` +
        `(${styleResult.created.join(', ')})`
    )
  );

  // 3. theme1.xml ----------------------------------------------------------
  write('word/theme/theme1.xml', patchTheme(read('word/theme/theme1.xml'), spec));
  console.log(chalk.gray(`  theme: major/minor latin -> ${spec.theme.minorLatin}`));

  // 4. header / footer parts ----------------------------------------------
  let relCounter = HF_REL_BASE;
  const refs = [];
  const partsForCT = [];
  for (const kind of ['header', 'footer']) {
    const list = kind === 'header' ? spec.headers : spec.footers;
    for (const item of list) {
      const relId = `rId${relCounter++}`;
      write(`word/${item.file}`, buildHeaderFooterPart(spec, item, kind));
      refs.push({ type: item.type, relId, kind, file: item.file });
      partsForCT.push({ part: `word/${item.file}`, kind });
    }
  }
  console.log(
    chalk.gray(
      `  parts: ${refs.map((r) => `${r.file}(${r.type})`).join(', ')}`
    )
  );

  // 5. document.xml sectPr -------------------------------------------------
  write('word/document.xml', patchDocument(read('word/document.xml'), spec, refs));
  console.log(
    chalk.gray(
      `  sectPr: ${spec.page.width}x${spec.page.height} twips, margin ${spec.margin}, ` +
        `gutter ${spec.gutter}, type ${spec.sectionType || 'none'}`
    )
  );

  // 6. settings.xml --------------------------------------------------------
  let settings = read('word/settings.xml');
  for (const rule of [...spec.settingsCommon, ...spec.settingsExtra]) {
    settings = insertRelative(settings, rule);
  }
  write('word/settings.xml', settings);
  console.log(
    chalk.gray(
      `  settings: ${[...spec.settingsCommon, ...spec.settingsExtra]
        .map((r) => /^<([A-Za-z0-9:]+)/.exec(r.xml)[1])
        .join(', ')}`
    )
  );

  // 7. embedded fonts ------------------------------------------------------
  const faces = [];
  for (const family of spec.embedFamilies) {
    for (const face of family.faces) {
      const ttf = path.join(FONTS_DIR, face.file);
      if (!fs.existsSync(ttf)) {
        throw new Error(
          `build-reference-docx: font not found: ${ttf}\n` +
            '  Embedding is not optional here — a missing face would silently ' +
            'fall back to a system font on every reader that lacks it.'
        );
      }
      faces.push({ family: family.name, style: face.style, ttfPath: ttf });
    }
  }
  const embedding = fontEmbed.buildFontEmbedding({ faces });

  for (const part of embedding.parts) write(part.path, part.data);
  write(
    'word/fontTable.xml',
    fontEmbed.injectFontTableEntries(
      read('word/fontTable.xml'),
      embedding.fontTableEntries,
      spec.embedFamilies.map((f) => f.name)
    )
  );
  write('word/_rels/fontTable.xml.rels', embedding.fontTableRelsXml);
  console.log(
    chalk.gray(
      `  fonts: ${embedding.parts.length} faces, ${kb(embedding.totalEmbeddedBytes)} raw ` +
        `(${[...new Set(embedding.licensing.map((l) => l.level))].join('; ')})`
    )
  );

  // 8. rels + content types ------------------------------------------------
  write(
    'word/_rels/document.xml.rels',
    addRelationships(
      read('word/_rels/document.xml.rels'),
      refs.map((r) => ({ id: r.relId, type: REL_TYPES[r.kind], target: r.file }))
    )
  );
  write('[Content_Types].xml', patchContentTypes(read('[Content_Types].xml'), partsForCT));

  // 9. zip -----------------------------------------------------------------
  zipDocx(srcDir, docxPath);
  const size = fs.statSync(docxPath).size;
  console.log(chalk.green(`  wrote ${path.relative(ROOT, docxPath)} (${kb(size)})`));
  console.log(chalk.gray(`  source  ${path.relative(ROOT, srcDir)}/`));

  return {
    variant: variantName,
    docxPath,
    srcDir,
    size,
    styles: styleResult,
    fonts: embedding.parts.length,
    fontBytes: embedding.totalEmbeddedBytes,
    parts: refs,
  };
}

// ===========================================================================
// CLI
// ===========================================================================

async function main() {
  const program = new Command();
  program
    .name('build-reference-docx')
    .description('Generate the pandoc reference.docx files for digital and print')
    .option('-v, --variant <name>', 'digital | print | both', 'both')
    .parse(process.argv);

  const { variant } = program.opts();
  const valid = ['digital', 'print', 'both'];
  if (!valid.includes(variant)) {
    console.error(chalk.red(`Unknown variant "${variant}"; expected ${valid.join(' | ')}`));
    process.exit(1);
  }

  // Fail fast on missing tools rather than half-writing an archive.
  for (const [tool, args] of [['pandoc', ['--version']], ['zip', ['-v']], ['unzip', ['-v']]]) {
    try {
      execFileSync(tool, args, { stdio: 'ignore' });
    } catch {
      throw new Error(`build-reference-docx: required tool "${tool}" is not available on PATH`);
    }
  }

  const variants = variant === 'both' ? ['digital', 'print'] : [variant];
  const reports = [];
  for (const v of variants) reports.push(await buildVariant(v));

  console.log(chalk.green.bold('\nDone.'));
  for (const r of reports) {
    console.log(
      `  ${path.relative(ROOT, r.docxPath)}  ${kb(r.size)}  ` +
        `${r.fonts} embedded faces, ${r.parts.length} header/footer parts`
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(chalk.red(`\n${err.message}`));
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = {
  buildVariant,
  patchStyles,
  patchTheme,
  patchDocument,
  buildHeaderFooterPart,
  splitElements,
  mergeOrdered,
  insertRelative,
};
