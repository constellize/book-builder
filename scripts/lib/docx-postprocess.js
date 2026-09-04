#!/usr/bin/env node

/**
 * docx-postprocess.js — the three fixes that CANNOT live in the reference doc.
 *
 *     node scripts/lib/docx-postprocess.js build/book.docx --variant print
 *
 * or, from the build script:
 *
 *     const { postProcessDocx } = require('./lib/docx-postprocess.js');
 *     postProcessDocx({ docxPath, variant });   // in place, idempotent
 *
 * ---------------------------------------------------------------------------
 * WHY A POST-PROCESS AND NOT A REFERENCE-DOC SETTING OR A LUA FILTER
 * ---------------------------------------------------------------------------
 * Everything else about these documents is expressed declaratively in
 * config/docx-styles.js and baked into templates/docx/reference-*.docx. These
 * three things cannot be, and the reasons are different for each:
 *
 *  1. OPEN-RIGHT CHAPTERS. `w:type="oddPage"` is a property of a SECTION, and
 *     pandoc emits exactly one section for the whole document — measured: one
 *     `<w:sectPr>` in a five-chapter conversion. So the reference doc's oddPage
 *     fires once, at document start, and never again; chapter 2 landed on page
 *     4, a verso. Getting per-chapter behaviour means emitting a sectPr per
 *     chapter, into content pandoc generates.
 *
 *     Not a style property: `w:style/w:pPr` is CT_PPrGeneral, which has no
 *     `w:sectPr` particle — only `w:p/w:pPr` (CT_PPr) does. Word discards it
 *     with no diagnostic.
 *
 *     Not a Lua filter: a sectPr does NOT inherit. Every one must restate pgSz,
 *     pgMar (gutter included), pgNumType, titlePg AND the headerReference /
 *     footerReference r:ids, or the section silently reverts to Word's defaults
 *     and the running heads disappear. A filter would have to reproduce r:ids
 *     out of a file it never sees, creating a cross-file contract that breaks
 *     silently the day the reference doc gains a part. This module instead
 *     CLONES the sectPr pandoc actually wrote into the output, so the ids are
 *     right by construction whatever they happen to be.
 *
 *  2. LIST MARKERS. pandoc reads the reference doc's word/numbering.xml and
 *     throws it away, synthesising its own. Measured: injected markers in
 *     `abstractNum` 990 and 991 — tampered nsid, tampered lvlText, tampered
 *     rFonts, plus an extra abstractNum — were ALL absent from the output,
 *     along with pandoc's own original nsid. A Lua filter cannot help either:
 *     numbering.xml is written by the docx writer, downstream of the AST, and
 *     the AST has no marker-font attribute to carry the request on. The output
 *     file is the first and only place the real numbering.xml exists.
 *
 *  3. THE TABLE OF CONTENTS CACHE. pandoc writes the TOC field with an EMPTY
 *     cached result, and a Word field shows its cache until something updates
 *     it — so the book opened on a BLANK Contents page for the whole life of
 *     this target. What has to change is the field's RESULT, which exists only
 *     in the output file: the AST a Lua filter sees has no page numbers in it,
 *     and no reference-doc setting can supply one (`<w:updateFields/>` was
 *     there for exactly this and is inert — see config/docx-styles.js
 *     settingsCommon for the A/B). The long version, including why one Word
 *     pass is enough and what ships when there is no Word, is in the
 *     "document.xml — the table of contents cache" section below.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCE
 * ---------------------------------------------------------------------------
 * All three patches are safe to re-run. Section breaks are removed and
 * re-inserted rather than appended to, the numbering patch overwrites rather
 * than accumulates, and the TOC field is located and REPLACED whole — the same
 * code finds pandoc's empty field and a cache built by an earlier run, because
 * structurally they are the same thing. N runs therefore produce the same bytes
 * as one, with one legitimate exception: a page number changes when the
 * manuscript's pagination has actually changed.
 *
 * @module scripts/lib/docx-postprocess
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const styleSpec = require('../../config/docx-styles.js');

/** Fixed timestamp, so re-zipping unchanged content yields identical bytes. */
const EPOCH = new Date('2020-01-01T00:00:00Z');

// ===========================================================================
// document.xml — one odd-page section per chapter
// ===========================================================================

/**
 * Matches a paragraph this module generated: a `<w:p>` whose `<w:pPr>` ends in a
 * `<w:sectPr>` and which contains no runs.
 *
 * pandoc never emits a paragraph-level sectPr, so in a pandoc-produced document
 * such a paragraph can only be ours. The run check is the second lock: it means
 * a hand-edited document that has grown a real sectPr-carrying paragraph with
 * content is left alone rather than silently deleted.
 */
const GENERATED_BREAK_RE =
  /<w:p\b[^>]*>\s*<w:pPr\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*<\/w:pPr>\s*<\/w:p>/g;

/**
 * Locate the document's body-level `<w:sectPr>` — the last one, the direct child
 * of `<w:body>`.
 *
 * @param {string} xml document.xml
 * @returns {{outer: string, inner: string, start: number, end: number}}
 * @throws {Error} if there is none, which means the file did not come from our
 *   reference doc and cloning would invent geometry rather than copy it
 */
function findBodySectPr(xml) {
  const re = /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g;
  let last = null;
  let m;
  while ((m = re.exec(xml)) !== null) last = m;
  if (!last) {
    throw new Error(
      'docx-postprocess: document.xml has no <w:sectPr>. This document was not ' +
        'produced with templates/docx/reference-*.docx, so there is no page ' +
        'geometry to clone and every chapter section would silently fall back ' +
        'to Word defaults.'
    );
  }
  const outer = last[0];
  return {
    outer,
    inner: outer.slice(outer.indexOf('>') + 1, outer.lastIndexOf('</w:sectPr>')),
    start: last.index,
    end: last.index + outer.length,
  };
}

/**
 * Build the per-chapter sectPr by cloning the body sectPr and forcing `w:type`.
 *
 * Everything else is copied verbatim, which is the whole point: the r:ids, the
 * page size, the margins and gutter, pgNumType and titlePg all come from the
 * document itself, so they cannot disagree with it.
 *
 * `w:titlePg` is deliberately KEPT. It makes each chapter's opening page draw
 * the two `first` parts — a blank header and a centred-folio footer — which is
 * the docx equivalent of the book class issuing \thispagestyle{plain} at
 * \chapter. Both references ride along in the clone, so chapter 2..N behave
 * identically to chapter 1; the guards below assert that rather than trust it.
 *
 * @param {string} bodyInner inner XML of the body sectPr
 * @param {object} spec resolved variant spec
 * @returns {string} a complete `<w:sectPr>...</w:sectPr>`
 * @throws {Error} if the cloned geometry is not the geometry the spec asked for
 */
function buildChapterSectPr(bodyInner, spec) {
  // Collapse inter-element whitespace: pandoc pretty-prints the body sectPr, and
  // the clone is going inside a paragraph where that indentation is noise.
  let inner = bodyInner.replace(/>\s+</g, '><').trim();

  // ---- fail loudly if this is not our geometry ---------------------------
  const pgSz = /<w:pgSz\b[^>]*\/>/.exec(inner);
  const pgMar = /<w:pgMar\b[^>]*\/>/.exec(inner);
  if (!pgSz || !pgMar) {
    throw new Error(
      'docx-postprocess: the body <w:sectPr> has no ' +
        `${pgSz ? '<w:pgMar>' : '<w:pgSz>'}. A cloned section without it reverts ` +
        'to Word defaults, which is exactly the silent failure this guard exists for.'
    );
  }
  const attr = (el, name) => {
    const m = new RegExp(`${name}="(-?\\d+)"`).exec(el);
    return m ? Number(m[1]) : null;
  };
  const geom = {
    w: attr(pgSz[0], 'w:w'),
    h: attr(pgSz[0], 'w:h'),
    gutter: attr(pgMar[0], 'w:gutter'),
  };
  const want = { w: spec.page.width, h: spec.page.height, gutter: spec.gutter };
  for (const k of ['w', 'h', 'gutter']) {
    if (geom[k] !== want[k]) {
      throw new Error(
        `docx-postprocess: document geometry ${k}=${geom[k]} does not match the ` +
          `"${spec.id}" spec (${want[k]}). Either the wrong --variant was passed or ` +
          'the document was converted against a different reference doc.'
      );
    }
  }
  // Every header/footer part the reference doc declares must have survived
  // pandoc into this document's body sectPr, because this clone is what every
  // chapter section gets. A sectPr does not inherit, so a reference that is
  // absent here is absent from all N chapter sections.
  //
  // The `first` FOOTER is the one that made this guard worth generalising.
  // `w:titlePg` suppresses the default/even footer on a section's opening page,
  // so if nothing is declared for `first` the page draws no footer at all —
  // and since the `first` header is deliberately blank, a chapter opening ends
  // up with neither a running head nor a folio. That is silent: the page just
  // has no number on it. Measured by stripping this one reference back out of a
  // six-chapter conversion and re-rendering: all 7 opening pages lost their
  // folio, against a print PDF that puts a centred one on every chapter opening.
  const declared = [
    ...spec.headers.map((h) => ['headerReference', h.type]),
    ...spec.footers.map((f) => ['footerReference', f.type]),
  ];
  const missing = declared.filter(
    ([el, type]) => !new RegExp(`<w:${el}\\b[^>]*\\bw:type="${type}"`).test(inner)
  );
  if (missing.length) {
    throw new Error(
      'docx-postprocess: the body <w:sectPr> is missing ' +
        missing.map(([el, type]) => `<w:${el} w:type="${type}">`).join(', ') +
        `, which the "${spec.id}" reference doc declares. Cloning it would give ` +
        'every chapter section a page with no running head or no page number. ' +
        'Rebuild with `node scripts/build-reference-docx.js --variant both` and ' +
        're-run pandoc.'
    );
  }

  // ---- force w:type, in schema position ----------------------------------
  // CT_SectPr order: headerReference*, footerReference*, footnotePr, endnotePr,
  // type, pgSz, ... — so w:type goes immediately before w:pgSz.
  inner = inner.replace(/<w:type\b[^>]*\/>/g, '');
  inner = inner.replace(/<w:pgSz\b/, `<w:type w:val="${spec.sectionType}"/><w:pgSz`);

  return `<w:sectPr>${inner}</w:sectPr>`;
}

/**
 * The paragraph that carries a section break.
 *
 * A sectPr inside a paragraph's pPr ends the section AT that paragraph, so this
 * paragraph is the LAST one of the preceding section — it sits at the bottom of
 * the previous page, where it must be invisible. `w:line="1" w:lineRule="exact"`
 * plus a 1pt paragraph mark gives it a 1-twip line box (1/1440 inch).
 *
 * `w:vanish` would be the other way to hide it, but hidden text is honoured
 * inconsistently across Word, LibreOffice and PDF export, and a section break
 * that disappears with it would be a spectacular silent failure. An exact
 * 1-twip line is understood identically everywhere.
 *
 * @param {string} sectPr complete `<w:sectPr>` element
 * @returns {string} XML
 */
function breakParagraph(sectPr) {
  return (
    '<w:p><w:pPr>' +
    '<w:pStyle w:val="BodyText"/>' +
    '<w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/>' +
    '<w:ind w:left="0" w:right="0" w:firstLine="0"/>' +
    '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>' +
    sectPr +
    '</w:pPr></w:p>'
  );
}

/**
 * Walk backwards from `at` over whitespace and `<w:bookmarkStart/>` elements.
 *
 * pandoc emits a heading's bookmark as `<w:bookmarkStart>` immediately BEFORE
 * the heading paragraph, and the TOC hyperlink lands on the start of that range.
 * Inserting the break between the bookmark and the heading would put the anchor
 * on the previous page, so every TOC entry would jump one page short. Inserting
 * before the bookmark keeps the anchor with its heading.
 *
 * `<w:bookmarkEnd/>` elements are deliberately NOT skipped: those close the
 * PREVIOUS chapter's range and belong in the previous section.
 *
 * @param {string} xml
 * @param {number} at
 * @returns {number} insertion offset
 */
function rewindOverBookmarks(xml, at) {
  let i = at;
  for (;;) {
    let j = i;
    while (j > 0 && /\s/.test(xml[j - 1])) j--;
    const m = /<w:bookmarkStart\b[^>]*\/>\s*$/.exec(xml.slice(0, j));
    if (!m) return j;
    i = m.index;
  }
}

/**
 * Insert one odd-page section break ahead of every chapter heading.
 *
 * A chapter that is already the FIRST block of the body gets no break. The body
 * sectPr's own `oddPage` has already put it on a recto, and a break paragraph
 * ahead of it would occupy page 1 and push the chapter to page 3 — measured: two
 * wasted leading pages on a document with no title page or TOC. The full book
 * always opens with a title page, but a single-chapter fragment handed to a
 * typesetter does not.
 *
 * @param {string} xml document.xml
 * @param {object} spec resolved variant spec
 * @returns {{xml: string, inserted: number, removed: number, skipped: number,
 *            sectPr: string}}
 * @throws {Error} if the document declares no chapter headings at all
 */
function insertChapterSections(xml, spec) {
  const body = findBodySectPr(xml);
  const sectPr = buildChapterSectPr(body.inner, spec);

  // Remove any breaks from a previous run first, so this is idempotent rather
  // than cumulative. Splice the body sectPr out while doing it: it is not inside
  // a paragraph and so cannot match, but excluding it removes all doubt.
  const head = xml.slice(0, body.start);
  const tail = xml.slice(body.start);
  let removed = 0;
  const cleaned =
    head.replace(GENERATED_BREAK_RE, (frag) => {
      if (/<w:r[\s>]/.test(frag)) return frag; // has content: not ours
      removed++;
      return '';
    }) + tail;

  const para = breakParagraph(sectPr);
  const styleAlt = spec.chapterBreakStyles.map((s) => escapeRe(s)).join('|');
  const headingRe = new RegExp(
    `<w:p\\b[^>]*>\\s*<w:pPr\\b[^>]*>\\s*<w:pStyle w:val="(?:${styleAlt})"\\s*/>`,
    'g'
  );

  const bodyOpen = /<w:body\b[^>]*>/.exec(cleaned);
  if (!bodyOpen) throw new Error('docx-postprocess: document.xml has no <w:body>');
  const bodyStart = bodyOpen.index + bodyOpen[0].length;

  const out = [];
  let pos = 0;
  let inserted = 0;
  let skipped = 0;
  let m;
  while ((m = headingRe.exec(cleaned)) !== null) {
    const at = rewindOverBookmarks(cleaned, m.index);
    if (at < pos) continue; // overlapping rewind; cannot happen, but never regress
    if (cleaned.slice(bodyStart, at).trim() === '') {
      skipped++; // already the first block; the body sectPr has it covered
      continue;
    }
    out.push(cleaned.slice(pos, at), para);
    pos = at;
    inserted++;
  }
  out.push(cleaned.slice(pos));

  if (inserted + skipped === 0) {
    throw new Error(
      `docx-postprocess: found no paragraphs styled ${spec.chapterBreakStyles.join('/')} ` +
        'in document.xml. Either the document has no chapters, or pandoc renamed ' +
        'the heading styles — in which case openright would silently do nothing.'
    );
  }

  return { xml: out.join(''), inserted, removed, skipped, sectPr };
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ===========================================================================
// numbering.xml — Atkinson list markers
// ===========================================================================

/**
 * XML-escape a marker character for use in an attribute value.
 * @param {string} s
 * @returns {string}
 */
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rewrite every `<w:lvl>` so its marker renders in the book font.
 *
 * Bullet levels additionally get their `w:lvlText` replaced: pandoc writes
 * U+F0B7 / U+F0A7, private-use-area code points that only mean anything in
 * Symbol and Wingdings. Pointing those at Atkinson without changing the text
 * would render two empty boxes, so the character and the font must move
 * together. The replacements (U+2022 / U+2013 / U+00B7) are verified present in
 * all eight embedded faces.
 *
 * Ordered levels keep their `w:lvlText` ("%1.", "(%1)", …) and only gain the
 * font: digits and the delimiters are all in Atkinson. pandoc emits ordered
 * levels with no `w:rPr` at all, so this is the append branch — the reason the
 * function cannot simply substitute an existing rFonts everywhere.
 *
 * Ids are never matched. pandoc derives `abstractNumId` from the list formats
 * present in the source (a document using lowerLetter/lowerRoman/upperLetter
 * produced 99431/99512/99711/99811), so anything keyed on them breaks the first
 * time an author adds a lettered list.
 *
 * pandoc's unused `abstractNum` 990 stub is patched along with the rest. That is
 * inert — verified: its `w:num` id 1000 is referenced by nothing in
 * document.xml — and treating all levels alike keeps this id-agnostic.
 *
 * @param {string} xml numbering.xml
 * @param {{font: string, bullets: string[]}} markers
 * @returns {{xml: string, levels: number, bullets: number, ordered: number}}
 * @throws {Error} on a malformed level or an empty bullet cycle
 */
function patchNumbering(xml, markers) {
  if (!Array.isArray(markers.bullets) || markers.bullets.length === 0) {
    throw new Error('docx-postprocess: listMarkers.bullets must be a non-empty array');
  }
  const rFonts = styleSpec.rFonts(markers.font, { hint: 'default' });

  let levels = 0;
  let bullets = 0;
  let ordered = 0;

  const out = xml.replace(/<w:lvl\b[^>]*>[\s\S]*?<\/w:lvl>/g, (lvl) => {
    levels++;
    const ilvlM = /<w:lvl\b[^>]*\bw:ilvl="(\d+)"/.exec(lvl);
    if (!ilvlM) {
      throw new Error(`docx-postprocess: <w:lvl> with no w:ilvl attribute: ${lvl.slice(0, 120)}`);
    }
    const ilvl = Number(ilvlM[1]);
    const fmtM = /<w:numFmt\b[^>]*\bw:val="([^"]*)"/.exec(lvl);
    if (!fmtM) {
      throw new Error(
        `docx-postprocess: <w:lvl w:ilvl="${ilvl}"> has no <w:numFmt>; cannot tell a ` +
          'bullet level from an ordered one.'
      );
    }
    let body = lvl;

    if (fmtM[1] === 'bullet') {
      bullets++;
      const marker = markers.bullets[ilvl % markers.bullets.length];
      const lvlTextRe = /<w:lvlText\b[^>]*\/>/;
      // Test for the ELEMENT, not for a change in the string: on a second run
      // the replacement is a no-op and a `before !== after` check would report a
      // missing element that is in fact already correct.
      if (!lvlTextRe.test(body)) {
        throw new Error(
          `docx-postprocess: bullet <w:lvl w:ilvl="${ilvl}"> has no <w:lvlText> to rewrite`
        );
      }
      body = body.replace(lvlTextRe, `<w:lvlText w:val="${escAttr(marker)}"/>`);
    } else {
      ordered++;
    }

    // w:rPr is the LAST child of w:lvl, after w:pPr. Replace an existing
    // w:rFonts outright (that is what strips w:hint="default" pointing at
    // Symbol), insert one if w:rPr exists without it, append a w:rPr if not.
    const rprAt = body.lastIndexOf('<w:rPr>');
    if (rprAt === -1) {
      body = body.replace(/<\/w:lvl>$/, `<w:rPr>${rFonts}</w:rPr></w:lvl>`);
    } else {
      const rprEnd = body.indexOf('</w:rPr>', rprAt);
      let rpr = body.slice(rprAt + '<w:rPr>'.length, rprEnd);
      rpr = /<w:rFonts\b[^>]*\/>/.test(rpr)
        ? rpr.replace(/<w:rFonts\b[^>]*\/>/, rFonts)
        : rFonts + rpr; // w:rFonts leads EG_RPrBase
      body = body.slice(0, rprAt) + `<w:rPr>${rpr}</w:rPr>` + body.slice(rprEnd + '</w:rPr>'.length);
    }
    return body;
  });

  if (levels === 0) {
    throw new Error(
      'docx-postprocess: numbering.xml contains no <w:lvl>. pandoc always emits ' +
        'at least its stub abstractNum, so this file is not what it should be.'
    );
  }
  return { xml: out, levels, bullets, ordered };
}

// ===========================================================================
// document.xml — the table of contents cache
// ===========================================================================

/**
 * ---------------------------------------------------------------------------
 * WHY THE TOC HAS TO BE BUILT HERE TOO
 * ---------------------------------------------------------------------------
 * pandoc's `--toc` emits the field with an EMPTY CACHED RESULT:
 *
 *     <w:p><w:r>
 *       <w:fldChar w:fldCharType="begin" w:dirty="true"/>
 *       <w:instrText xml:space="preserve">TOC \o "1-3" \h \z \u</w:instrText>
 *       <w:fldChar w:fldCharType="separate"/>
 *       <w:fldChar w:fldCharType="end"/>
 *     </w:r></w:p>
 *
 * Nothing between `separate` and `end`. A Word field displays its cached result
 * until something updates it, so the reader opens the book and the Contents page
 * is BLANK. The PDFs never showed this because scripts/lib/docx-render.js
 * updates the field on the way to PDF, which masked it for the whole life of
 * the target.
 *
 * `<w:updateFields w:val="true"/>` does not fix it. Whether Word refreshes on
 * open is governed by the user's "update automatic links at open" preference,
 * and on the author's machine that preference is OFF — so the field would never
 * have populated for them under any circumstances. See config/docx-styles.js
 * settingsCommon for the A/B that established this.
 *
 * So the field result is written into document.xml here, which is the only
 * place it can be written: the cache is a property of the output file, and the
 * AST a Lua filter sees has no page numbers in it.
 *
 * ---------------------------------------------------------------------------
 * THE THREE STAGES, AND WHY IT CONVERGES IN ONE PASS
 * ---------------------------------------------------------------------------
 *   1. SKELETON (here, pure Node). Inject the TOC1-3 styles, then re-emit the
 *      field with one entry paragraph per Heading1-3, each a hyperlink to the
 *      bookmark pandoc already wrote for that heading, each ending in a PAGEREF
 *      field whose cached result is blank.
 *   2. ORACLE (docx-render.js updateTocCache, ~6s of Word). Word repaginates and
 *      fills in the PAGEREF results. Its re-saved package is read and thrown
 *      away; it is not fit to ship (see that function for the font damage).
 *   3. SPLICE (here, pure Node). Re-emit the same entries with the numbers.
 *
 * Stage 3 cannot invalidate stage 2's measurement, so there is no LaTeX-style
 * iterate-to-fixpoint problem:
 *   - the oracle is asked ONLY to update page numbers, never to rebuild the
 *     field, so it paginates our exact paragraphs in our exact styles;
 *   - a page number sits after a right-aligned tab on a line that already
 *     exists, so writing it cannot change the line count, cannot change the
 *     length of the Contents, and therefore cannot move anything.
 * Measured: re-running the oracle on the spliced output gave 0 page differences
 * and 0 text differences across all 159 entries, and rendering the spliced file
 * WITHOUT updating any field put 159/159 entries on the physical page the
 * heading actually appears on.
 *
 * ---------------------------------------------------------------------------
 * WITHOUT WORD
 * ---------------------------------------------------------------------------
 * Stage 2 is optional. `\n` added to the field instruction suppresses page
 * numbers, and buildTocField() then omits the leader tab and the PAGEREF runs
 * entirely, so the fallback is a complete, correctly indented, fully clickable
 * Contents with no numbers — not a Contents whose dot leaders run to a blank.
 * The build succeeds and warns. It never hard-requires a GUI application.
 */

/** Style ids for the three outline levels. Index 0 = level 1. */
const TOC_STYLE_IDS = ['TOC1', 'TOC2', 'TOC3'];

/**
 * What the Contents page is called, in the running head over it.
 *
 * Matches the TOCHeading paragraph pandoc writes ("Contents", set by the
 * `toc-title` in the docx defaults file) and what the LaTeX targets print.
 * Used only by applyContentsHeader().
 */
const TOC_HEADING_TEXT = 'Contents';

/** `<w:rPr>` shared by the hidden runs that carry the page number. */
const TOC_RPR_HIDDEN = '<w:rPr><w:noProof/><w:webHidden/></w:rPr>';

/** `<w:rPr>` for the visible, clickable entry text. */
const TOC_RPR_LINK = '<w:rPr><w:rStyle w:val="Hyperlink"/><w:noProof/></w:rPr>';

/**
 * The `toc 1` / `toc 2` / `toc 3` paragraph style definitions.
 *
 * Emitted WITHOUT `w:customStyle="1"`: these are built-in Word styles and the
 * `w:name` values ("toc 1"...) are the built-in names. Marking a built-in as
 * custom is what makes Word create a second, parallel style when a reader
 * rebuilds the field.
 *
 * `w:firstLine="0"` is not cosmetic. These are `basedOn BodyText`, and BodyText
 * carries the book's 340tw paragraph indent; without the reset every entry
 * would inherit it.
 *
 * @param {object} spec resolved config/docx-styles.js spec
 * @returns {string} three `<w:style>` elements
 */
function tocStyleXml(spec) {
  return spec.toc.levels
    .map((lv, i) => {
      const n = i + 1;
      return (
        `<w:style w:type="paragraph" w:styleId="${TOC_STYLE_IDS[i]}">` +
        `<w:name w:val="toc ${n}"/>` +
        '<w:basedOn w:val="BodyText"/><w:next w:val="BodyText"/>' +
        '<w:uiPriority w:val="39"/><w:unhideWhenUsed/>' +
        '<w:pPr>' +
        // Leading must be an EXPLICIT twip value with lineRule="atLeast", not
        // 240/auto. `auto` multiplies the FONT's natural line height (Atkinson is
        // 1.157em -> 12.73pt at 11pt), which renders ~6% tight against LaTeX - the
        // same defect, and the same magnitude, as the original body-text bug.
        // TOC1-3 are basedOn BodyText but OVERRIDE spacing here, so they inherit
        // nothing: this line is the only thing setting Contents leading.
        `<w:spacing w:before="${lv.before}" w:after="${lv.after}" ` +
        `w:line="${styleSpec.LINE.body}" w:lineRule="atLeast"/>` +
        `<w:ind w:left="${lv.indent}" w:right="0" w:firstLine="0"/>` +
        '</w:pPr>' +
        (lv.bold ? '<w:rPr><w:b/><w:bCs/></w:rPr>' : '') +
        '</w:style>'
      );
    })
    .join('');
}

/**
 * Add the TOC1-3 styles to word/styles.xml, replacing any already there.
 *
 * Idempotent by replacement rather than by "skip if present", so a change to
 * the spec takes effect on a re-run instead of being silently ignored.
 *
 * @param {string} xml word/styles.xml
 * @param {object} spec resolved spec
 * @returns {{xml: string, injected: string[], replaced: string[]}}
 * @throws {Error} if there is no `</w:styles>` to insert before
 */
function injectTocStyles(xml, spec) {
  const injected = [];
  const replaced = [];
  let out = xml;

  for (let i = 0; i < TOC_STYLE_IDS.length; i++) {
    const id = TOC_STYLE_IDS[i];
    const one = tocStyleXml(spec).match(
      new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`)
    )[0];
    const existing = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`);
    if (existing.test(out)) {
      out = out.replace(existing, one);
      replaced.push(id);
    } else {
      const close = out.lastIndexOf('</w:styles>');
      if (close === -1) {
        throw new Error('docx-postprocess: word/styles.xml has no </w:styles>');
      }
      out = out.slice(0, close) + one + out.slice(close);
      injected.push(id);
    }
  }
  return { xml: out, injected, replaced };
}

/**
 * Locate the whole TOC field, from the `<w:p>` that opens it to the `</w:p>`
 * that closes it.
 *
 * Handles BOTH shapes with one piece of code, which is what makes re-running
 * safe: pandoc's empty single-paragraph field and our own multi-paragraph cache
 * are the same structure, one just has nothing between `separate` and `end`.
 * Nested PAGEREF fields inside the entries are balanced, so counting
 * begin/end back down to zero always lands on the TOC's own terminator.
 *
 * @param {string} xml document.xml
 * @returns {{start: number, end: number, instr: string}|null}
 * @throws {Error} if the field opens but never closes
 */
function findTocField(xml) {
  const instrRe = /<w:instrText\b[^>]*>\s*(TOC\b[^<]*?)\s*<\/w:instrText>/;
  const m = instrRe.exec(xml);
  if (!m) return null;

  // Back up to the paragraph that contains the field's `begin`.
  const pStart = Math.max(xml.lastIndexOf('<w:p>', m.index), xml.lastIndexOf('<w:p ', m.index));
  if (pStart === -1) throw new Error('docx-postprocess: TOC field is not inside a <w:p>');

  // Walk forward over fldChar begin/end until the outermost field closes.
  const charRe = /<w:fldChar\b[^>]*w:fldCharType="(begin|end)"[^>]*\/>/g;
  charRe.lastIndex = pStart;
  let depth = 0;
  let closeAt = -1;
  let c;
  while ((c = charRe.exec(xml)) !== null) {
    depth += c[1] === 'begin' ? 1 : -1;
    if (depth === 0) {
      closeAt = c.index + c[0].length;
      break;
    }
  }
  if (closeAt === -1) {
    throw new Error('docx-postprocess: the TOC field opens but never closes');
  }
  const pEnd = xml.indexOf('</w:p>', closeAt);
  if (pEnd === -1) throw new Error('docx-postprocess: TOC field runs past the last paragraph');

  return {
    start: pStart,
    end: pEnd + '</w:p>'.length,
    instr: unescapeXmlAttr(m[1]),
  };
}

/** Undo the entity escaping pandoc applies inside `<w:instrText>`. */
function unescapeXmlAttr(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Escape text for a text node. */
function escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Every Heading1-3 paragraph, in document order, with the bookmark that anchors
 * it and its text split into section number and title.
 *
 * The number/title split matters because pandoc writes the number as a
 * SectionNumber-styled run followed by a bare `<w:tab/>`, and a tab is not text.
 * Concatenating every `<w:t>` would give "1The Intent-Implementation Gap"; the
 * TOC needs the two halves separated by a tab of its own so the titles line up.
 *
 * Run text is carried through as the ALREADY-ESCAPED source XML rather than
 * being decoded and re-encoded. Titles in this book contain typographic
 * apostrophes and en dashes; a decode/encode round trip is a chance to get one
 * of them wrong for no benefit.
 *
 * @param {string} xml document.xml
 * @param {object} spec resolved spec
 * @returns {Array<{level: number, anchor: string, number: string|null, title: string}>}
 * @throws {Error} if a heading has no bookmark to link to
 */
function collectTocHeadings(xml, spec) {
  const bodyOpen = /<w:body\b[^>]*>/.exec(xml);
  if (!bodyOpen) throw new Error('docx-postprocess: document.xml has no <w:body>');

  const paraRe = /<w:p\b(?:\s[^>]*)?>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/g;
  const runRe = /<w:r\b(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  const out = [];
  const unanchored = [];

  let m;
  while ((m = paraRe.exec(xml)) !== null) {
    const lvl = /<w:pStyle w:val="Heading([1-3])"\s*\/>/.exec(m[0]);
    if (!lvl) continue;
    const level = Number(lvl[1]);

    // The bookmark pandoc emits immediately before the heading. Verified
    // present for all 159 headings; docx-postprocess's own chapter break is
    // inserted BEFORE it precisely so this adjacency survives (see
    // rewindOverBookmarks).
    const before = xml.slice(0, m.index).replace(/\s+$/, '');
    const bm = /<w:bookmarkStart\b[^>]*w:name="([^"]+)"\s*\/>$/.exec(before);

    let number = null;
    const titleParts = [];
    let r;
    runRe.lastIndex = 0;
    while ((r = runRe.exec(m[0])) !== null) {
      const t = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/.exec(r[0]);
      if (!t) continue;
      if (/<w:rStyle w:val="SectionNumber"\s*\/>/.test(r[0])) number = t[1];
      else titleParts.push(t[1]);
    }

    if (!bm) {
      unanchored.push(titleParts.join('').slice(0, 40));
      continue;
    }
    out.push({ level, anchor: bm[1], number, title: titleParts.join('') });
  }

  if (unanchored.length) {
    throw new Error(
      `docx-postprocess: ${unanchored.length} of ${out.length + unanchored.length} headings ` +
        'have no <w:bookmarkStart> immediately before them, so no TOC entry could link to ' +
        `them: ${unanchored.slice(0, 3).join(', ')}. pandoc emits one per heading; something ` +
        'upstream is stripping them.'
    );
  }
  if (out.length === 0) {
    throw new Error(
      `docx-postprocess: found no Heading1-3 paragraphs, so the ${spec.toc.instruction} ` +
        'field would have nothing to point at.'
    );
  }
  return out;
}

/**
 * One TOC entry paragraph.
 *
 * Shape is Word's own, minus the parts of Word's that we do not want: no
 * `w:rsid*`, no `w14:paraId`, and crucially no direct `<w:rPr>` carrying
 * `w:rFonts asciiTheme="minorHAnsi"` and `w:sz w:val="24"`. Word stamps those
 * onto every entry when IT builds a TOC, which is how a Contents ends up in a
 * different face and size from the book. Ours inherit from TOC1-3, which
 * inherit from BodyText.
 */
function tocEntryXml(entry, opts, spec) {
  const level = entry.level;
  const lv = spec.toc.levels[level - 1];
  const tabs =
    '<w:tabs>' +
    (entry.number !== null
      ? `<w:tab w:val="left" w:pos="${lv.indent + spec.toc.numberTab(level)}"/>`
      : '') +
    (opts.pageNumbers
      ? `<w:tab w:val="right" w:leader="dot" w:pos="${spec.toc.leaderTabPos}"/>`
      : '') +
    '</w:tabs>';

  const pPr =
    `<w:pPr><w:pStyle w:val="${TOC_STYLE_IDS[level - 1]}"/>${tabs}` +
    '<w:rPr><w:noProof/></w:rPr></w:pPr>';

  // The TOC field's own begin/instrText/separate go inside the FIRST entry
  // paragraph and its `end` inside the LAST, exactly as Word writes it. That is
  // what makes the whole block one field the reader can still refresh with F9.
  const lead = opts.first
    ? '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      `<w:r><w:instrText xml:space="preserve">${escText(opts.instr)}</w:instrText></w:r>` +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    : '';

  let text = '';
  if (entry.number !== null) {
    text += `<w:r>${TOC_RPR_LINK}<w:t xml:space="preserve">${entry.number}</w:t></w:r>`;
    text += `<w:r><w:rPr><w:noProof/></w:rPr><w:tab/></w:r>`;
  }
  text += `<w:r>${TOC_RPR_LINK}<w:t xml:space="preserve">${entry.title}</w:t></w:r>`;

  // `\n` in the instruction suppresses page numbers; emitting the leader tab and
  // the PAGEREF anyway would give a dot leader running to nothing.
  const page = opts.pageNumbers
    ? `<w:r>${TOC_RPR_HIDDEN}<w:tab/></w:r>` +
      `<w:r>${TOC_RPR_HIDDEN}<w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r>${TOC_RPR_HIDDEN}<w:instrText xml:space="preserve"> PAGEREF ${entry.anchor} \\h </w:instrText></w:r>` +
      `<w:r>${TOC_RPR_HIDDEN}<w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r>${TOC_RPR_HIDDEN}<w:t>${escText(opts.page == null ? '' : opts.page)}</w:t></w:r>` +
      `<w:r>${TOC_RPR_HIDDEN}<w:fldChar w:fldCharType="end"/></w:r>`
    : '';

  const tail = opts.last ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : '';

  return (
    `<w:p>${pPr}${lead}` +
    `<w:hyperlink w:anchor="${escText(entry.anchor)}" w:history="1">${text}${page}</w:hyperlink>` +
    `${tail}</w:p>`
  );
}

/**
 * The whole field, as the replacement for whatever findTocField() matched.
 *
 * @param {Array} headings from collectTocHeadings()
 * @param {object} spec resolved spec
 * @param {object} [opts]
 * @param {boolean} [opts.pageNumbers=true] false emits the `\n` (no page numbers) form
 * @param {Array<string|number>} [opts.pages] cached page number per entry, index-aligned;
 *   omit for the blank-numbered skeleton the oracle is asked to fill in
 * @returns {string} XML
 */
function buildTocField(headings, spec, opts = {}) {
  const pageNumbers = opts.pageNumbers !== false;
  const pages = opts.pages || [];
  const instr = pageNumbers ? spec.toc.instruction : spec.toc.instructionNoPages;
  return headings
    .map((h, i) =>
      tocEntryXml(h, {
        first: i === 0,
        last: i === headings.length - 1,
        instr,
        pageNumbers,
        page: pages[i],
      }, spec)
    )
    .join('');
}

/**
 * Replace the TOC field in `xml` with `field`.
 *
 * @returns {{xml: string, instr: string}}
 * @throws {Error} if there is no TOC field — the docx targets always ask pandoc
 *   for one, so its absence means `--toc` stopped being passed and the Contents
 *   page would ship empty again
 */
function replaceTocField(xml, field) {
  const found = findTocField(xml);
  if (!found) {
    throw new Error(
      'docx-postprocess: document.xml contains no TOC field. The docx targets pass ' +
        '--toc, so this means the defaults file or the pandoc invocation changed and ' +
        'the book would ship with no Contents at all.'
    );
  }
  return {
    xml: xml.slice(0, found.start) + field + xml.slice(found.end),
    instr: found.instr,
  };
}

/**
 * Read the PAGEREF results Word computed, in document order.
 *
 * Restricted to the span of the TOC field so a PAGEREF anywhere else in the
 * document could never be mistaken for an entry.
 *
 * @param {string} xml the oracle's word/document.xml
 * @returns {Array<{anchor: string, page: string}>}
 */
function readTocPageNumbers(xml) {
  const field = findTocField(xml);
  if (!field) return [];
  const span = xml.slice(field.start, field.end);

  const out = [];
  const re =
    /<w:instrText\b[^>]*>\s*PAGEREF\s+(\S+)\s+\\h\s*<\/w:instrText>([\s\S]*?)<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>/g;
  let m;
  while ((m = re.exec(span)) !== null) {
    // The cached result is the LAST text node before the field's `end`; Word
    // writes an empty run and a `separate` in between.
    const texts = [...m[2].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)];
    out.push({
      anchor: m[1],
      page: texts.length ? texts[texts.length - 1][1].trim() : '',
    });
  }
  return out;
}

// ===========================================================================
// header parts — the running head over the Contents
// ===========================================================================

/**
 * ---------------------------------------------------------------------------
 * WHY THE CONTENTS PAGES SAY "FOREWORD" AND "BEFORE YOU ASK"
 * ---------------------------------------------------------------------------
 * The running heads are STYLEREF fields: the recto header prints the current
 * `Heading 1`, the verso header the current `Heading 2`. STYLEREF in a header
 * looks for its style on the current page first; failing that it searches
 * BACKWARD to the start of the document; failing that it searches FORWARD to
 * the end. On the Contents pages all three headings styles are absent and there
 * is nothing before them, so the forward search wins and the header prints the
 * first heading of the BODY. LaTeX prints "Contents" because it sets the mark
 * explicitly; Word cannot be argued out of the search order.
 *
 * There is no field that fixes this, so the fix is structural, and cheap
 * because the structure is already there: the paragraph docx-postprocess
 * inserts before the Foreword ENDS the front-matter section, so the title page
 * and the Contents are already a section of their own. Give that section its
 * own two header parts, identical to the book's but with the STYLEREF replaced
 * by the literal word "Contents", and nothing else in the document is touched.
 *
 * The title page is unaffected: the section carries `<w:titlePg/>`, so its
 * first page uses the `first` header (empty) either way.
 *
 * NON-FATAL. If the header parts do not have the shape this expects, the
 * Contents keeps the wrong running head and the build says so. A cosmetic
 * running head is not worth failing a book over.
 */
const CONTENTS_HEADER_PARTS = {
  default: { part: 'word/headerContentsOdd.xml', rid: 'rIdContentsHeaderOdd' },
  even: { part: 'word/headerContentsEven.xml', rid: 'rIdContentsHeaderEven' },
};

const HEADER_CT =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const HEADER_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';

/**
 * Replace a header's STYLEREF field with literal text, keeping everything else
 * — including the PAGE field that prints the folio, and the rule under the
 * header table.
 *
 * @returns {string|null} the new XML, or null if there is no STYLEREF field
 */
function styleRefToLiteral(headerXml, text) {
  const field =
    /<w:r>\s*<w:fldChar w:fldCharType="begin"\s*\/>\s*<\/w:r>\s*<w:r>\s*<w:instrText\b[^>]*>\s*STYLEREF[\s\S]*?<w:fldChar w:fldCharType="end"\s*\/>\s*<\/w:r>/;
  if (!field.test(headerXml)) return null;
  return headerXml.replace(
    field,
    `<w:r><w:t xml:space="preserve">${escText(text)}</w:t></w:r>`
  );
}

/**
 * Point the front-matter section at its own headers.
 *
 * @param {object} io {read, write, exists} over the unzipped package
 * @param {string} docXml document.xml, AFTER insertChapterSections
 * @param {string} text what the running head should say
 * @returns {{xml: string, applied: boolean, reason: string|null, parts: string[]}}
 */
function applyContentsHeader(io, docXml, text) {
  const skip = (reason) => ({ xml: docXml, applied: false, reason, parts: [] });

  // The first paragraph-level sectPr is the one that terminates the front
  // matter. Assert it rather than assume it: everything before it must contain
  // the TOC field, or this is not the section we think it is.
  GENERATED_BREAK_RE.lastIndex = 0;
  const first = GENERATED_BREAK_RE.exec(docXml);
  GENERATED_BREAK_RE.lastIndex = 0;
  if (!first) return skip('no generated section break to attach it to');
  if (!/<w:instrText\b[^>]*>\s*TOC\b/.test(docXml.slice(0, first.index))) {
    return skip(
      'the first section break does not follow the TOC field, so the front matter ' +
        'is not the section it terminates'
    );
  }

  // Already done. Only reachable by re-running on our own output (the build
  // always starts from fresh pandoc output), but without this a second pass
  // would go looking for a STYLEREF in a header that no longer has one and
  // report the success as a failure.
  const already = Object.values(CONTENTS_HEADER_PARTS).every(
    (s) => io.exists(s.part) && new RegExp(`r:id="${s.rid}"`).test(first[0])
  );
  if (already) {
    return {
      xml: docXml,
      applied: true,
      reason: null,
      parts: Object.values(CONTENTS_HEADER_PARTS).map((s) => s.part),
    };
  }

  const rels = 'word/_rels/document.xml.rels';
  if (!io.exists(rels)) return skip(`${rels} is missing`);
  let relsXml = io.read(rels);
  let ctXml = io.read('[Content_Types].xml');
  let breakXml = first[0];
  const written = [];

  for (const [type, spec] of Object.entries(CONTENTS_HEADER_PARTS)) {
    const ref = new RegExp(`<w:headerReference\\b[^>]*w:type="${type}"[^>]*/>`).exec(breakXml);
    if (!ref) return skip(`the section break has no ${type} headerReference`);
    const srcRid = (/r:id="([^"]+)"/.exec(ref[0]) || [])[1];
    if (!srcRid) return skip(`the ${type} headerReference has no r:id`);

    const target = new RegExp(
      `<Relationship\\b[^>]*\\bId="${escapeRe(srcRid)}"[^>]*\\bTarget="([^"]+)"[^>]*/?>`
    ).exec(relsXml);
    const target2 =
      target ||
      new RegExp(
        `<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${escapeRe(srcRid)}"[^>]*/?>`
      ).exec(relsXml);
    if (!target2) return skip(`no relationship for ${srcRid}`);
    const srcPart = `word/${target2[1]}`;
    if (!io.exists(srcPart)) return skip(`${srcPart} is missing`);

    const literal = styleRefToLiteral(io.read(srcPart), text);
    if (literal === null) return skip(`${srcPart} has no STYLEREF field to replace`);

    io.write(spec.part, literal);
    written.push(spec.part);

    // Relationship and content type, both idempotent: a re-run finds them and
    // adds nothing.
    if (!relsXml.includes(`Id="${spec.rid}"`)) {
      relsXml = relsXml.replace(
        '</Relationships>',
        `<Relationship Id="${spec.rid}" Target="${path.basename(spec.part)}" ` +
          `Type="${HEADER_REL_TYPE}"/></Relationships>`
      );
    }
    const override = `<Override PartName="/${spec.part}" ContentType="${HEADER_CT}"/>`;
    if (!ctXml.includes(`PartName="/${spec.part}"`)) {
      ctXml = ctXml.replace('</Types>', `${override}</Types>`);
    }

    breakXml = breakXml.replace(
      ref[0],
      `<w:headerReference r:id="${spec.rid}" w:type="${type}"/>`
    );
  }

  io.write(rels, relsXml);
  io.write('[Content_Types].xml', ctXml);
  return {
    xml: docXml.slice(0, first.index) + breakXml + docXml.slice(first.index + first[0].length),
    applied: true,
    reason: null,
    parts: written,
  };
}

// ===========================================================================
// settings.xml — stop asking Word to throw the cache away
// ===========================================================================

/**
 * Remove the two "this field is stale, please recompute" markers.
 *
 * With a real cached result in place, both are actively harmful: they are what
 * makes Word show the "fields that may refer to other files" modal on open, and
 * for a reader who answers No (or whose preference answers No for them) the
 * result is the blank Contents this whole exercise exists to remove. Measured
 * A/B on the same open-and-count operation with the preference ON: the old file
 * blocked on the modal and died after 71.3s; the file with cache-and-no-flags
 * opened in 1.65s.
 *
 * The field is still a field. F9 rebuilds it; nothing is frozen.
 */
function stripFieldRefreshFlags(docXml, settingsXml) {
  const dirty = (docXml.match(/\sw:dirty="(?:true|1)"/g) || []).length;
  const doc = docXml.replace(/(<w:fldChar\b[^>]*?)\sw:dirty="(?:true|1)"/g, '$1');
  const updates = (settingsXml.match(/<w:updateFields\b[^>]*\/>/g) || []).length;
  const settings = settingsXml.replace(/<w:updateFields\b[^>]*\/>\s*/g, '');
  return { doc, settings, dirty, updates };
}

// ===========================================================================
// package round-trip
// ===========================================================================

/**
 * Zip the working directory to `target`, byte-stably.
 *
 * Same round trip everywhere: fixed mtimes, `[Content_Types].xml` first, `-X` to
 * drop the extra-field metadata that would otherwise vary run to run.
 */
function rezip(work, target) {
  for (const p of walk(work)) fs.utimesSync(p, EPOCH, EPOCH);
  const abs = path.resolve(target);
  if (fs.existsSync(abs)) fs.rmSync(abs);
  const entries = fs
    .readdirSync(work)
    .filter((e) => e !== '[Content_Types].xml')
    .sort();
  execFileSync('zip', ['-q', '-r', '-X', abs, '[Content_Types].xml', ...entries], {
    cwd: work,
  });
  return abs;
}

/**
 * Stage 2+3: get real page numbers into the cache, or degrade cleanly.
 *
 * Called with the skeleton already written into `work` and already zipped to
 * `skeletonPath`. Returns what happened; NEVER throws for an environmental
 * reason, because a docx build must not become impossible without a GUI Word.
 *
 * @returns {{pageNumbers: boolean, oracleMs: number|null, warning: string|null,
 *            rebuilt: boolean}}
 */
function fillTocPageNumbers({ work, skeletonPath, headings, spec, oracle, log }) {
  const oracleOut = `${skeletonPath}.oracle.docx`;
  const docPath = path.join(work, 'word/document.xml');
  const degrade = (warning) => {
    // The `\n` form: no leader tab, no PAGEREF, a complete clickable Contents
    // with no numbers. Preferred over leaving blanks after the dot leaders.
    const doc = fs.readFileSync(docPath, 'utf8');
    fs.writeFileSync(
      docPath,
      replaceTocField(doc, buildTocField(headings, spec, { pageNumbers: false })).xml
    );
    return { pageNumbers: false, oracleMs: null, warning, rebuilt: false };
  };

  let res;
  try {
    res = oracle(skeletonPath, oracleOut);
  } catch (err) {
    return degrade(`the Word page-number oracle threw: ${err.message}`);
  }
  if (!res.ok) {
    return degrade(res.reason + (res.hint ? ` (${res.hint})` : ''));
  }

  try {
    const oracleDoc = execFileSync('unzip', ['-p', oracleOut, 'word/document.xml'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    const got = readTocPageNumbers(oracleDoc);

    if (got.length !== headings.length) {
      return degrade(
        `Word returned ${got.length} page numbers for ${headings.length} headings; ` +
          'the cache would have been misaligned, so it was left without numbers'
      );
    }
    const blank = got.filter((g) => !g.page).length;
    if (blank) {
      return degrade(`Word left ${blank} of ${got.length} page numbers blank`);
    }
    const nonNumeric = got.filter((g) => !/^[0-9ivxlcdmIVXLCDM]+$/.test(g.page));
    if (nonNumeric.length) {
      return degrade(
        `Word returned ${nonNumeric.length} page number(s) that are not page numbers, ` +
          `e.g. ${JSON.stringify(nonNumeric[0].page)}`
      );
    }

    // If the anchors still match, Word updated our cache in place and did not
    // rebuild the field — which is what the script asks for, and what makes the
    // measurement exactly the document we ship. Worth reporting either way.
    const rebuilt = got.some((g, i) => g.anchor !== headings[i].anchor);

    const doc = fs.readFileSync(docPath, 'utf8');
    fs.writeFileSync(
      docPath,
      replaceTocField(
        doc,
        buildTocField(headings, spec, { pageNumbers: true, pages: got.map((g) => g.page) })
      ).xml
    );
    log(
      `  toc:       ${got.length} page numbers from Word in ${(res.ms / 1000).toFixed(1)}s ` +
        `(first "${headings[0].title}" p${got[0].page}, last p${got[got.length - 1].page})` +
        (rebuilt ? ' [Word rebuilt the field; matched positionally]' : '')
    );
    return { pageNumbers: true, oracleMs: res.ms, warning: null, rebuilt };
  } catch (err) {
    return degrade(`could not read Word's page numbers back: ${err.message}`);
  } finally {
    fs.rmSync(oracleOut, { force: true });
  }
}

/**
 * Unzip, patch, re-zip. In place unless `outPath` is given.
 *
 * @param {object} opts
 * @param {string} opts.docxPath .docx to process
 * @param {'digital'|'print'} opts.variant which reference doc produced it
 * @param {string} [opts.outPath] write here instead of over the input
 * @param {(msg: string) => void} [opts.log]
 * @param {'auto'|'never'} [opts.tocPageNumbers='auto'] 'never' skips the Word
 *   oracle entirely and ships the page-number-free Contents. 'auto' uses Word
 *   when it is there and degrades to that same Contents when it is not.
 * @param {(inPath: string, outPath: string) => object} [opts.tocOracle] injected
 *   for tests; defaults to docx-render.js updateTocCache
 * @returns {{docxPath: string, sections: number, removed: number, levels: number,
 *            bullets: number, ordered: number, bytes: number, toc: object}}
 */
function postProcessDocx({
  docxPath,
  variant,
  outPath,
  log = () => {},
  tocPageNumbers = 'auto',
  tocOracle,
  contentsHeader = true,
}) {
  const spec = styleSpec.resolve(variant);
  if (!fs.existsSync(docxPath)) {
    throw new Error(`docx-postprocess: no such file: ${docxPath}`);
  }
  if (tocPageNumbers !== 'auto' && tocPageNumbers !== 'never') {
    throw new Error(
      `docx-postprocess: tocPageNumbers must be 'auto' or 'never', got ${JSON.stringify(tocPageNumbers)}`
    );
  }
  const target = outPath || docxPath;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docxpp-'));

  try {
    execFileSync('unzip', ['-q', path.resolve(docxPath), '-d', work]);

    for (const rel of ['word/document.xml', 'word/numbering.xml']) {
      if (!fs.existsSync(path.join(work, rel))) {
        throw new Error(
          `docx-postprocess: ${docxPath} has no ${rel}. pandoc emits both for every ` +
            'docx it writes, so this archive is not a pandoc output.'
        );
      }
    }

    const docPath = path.join(work, 'word/document.xml');
    const sect = insertChapterSections(fs.readFileSync(docPath, 'utf8'), spec);
    fs.writeFileSync(docPath, sect.xml);
    log(
      `  openright: ${sect.inserted} chapter sections (w:type=${spec.sectionType})` +
        (sect.skipped ? `, ${sect.skipped} already first in body` : '') +
        (sect.removed ? `, ${sect.removed} stale break(s) replaced` : '')
    );

    const numPath = path.join(work, 'word/numbering.xml');
    const num = patchNumbering(fs.readFileSync(numPath, 'utf8'), spec.listMarkers);
    fs.writeFileSync(numPath, num.xml);
    log(
      `  markers:   ${num.levels} levels -> ${spec.listMarkers.font} ` +
        `(${num.bullets} bullet, ${num.ordered} ordered), ` +
        `bullets ${spec.listMarkers.bullets.join(' ')}`
    );

    // ---- the Contents pages' running head ---------------------------------
    const io = {
      exists: (rel) => fs.existsSync(path.join(work, rel)),
      read: (rel) => fs.readFileSync(path.join(work, rel), 'utf8'),
      write: (rel, data) => fs.writeFileSync(path.join(work, rel), data),
    };
    const head = contentsHeader
      ? applyContentsHeader(io, sect.xml, TOC_HEADING_TEXT)
      : { xml: sect.xml, applied: false, reason: 'disabled by caller', parts: [] };
    log(
      head.applied
        ? `  heading:   front-matter running head -> "${TOC_HEADING_TEXT}" ` +
          `(${head.parts.map((p) => path.basename(p)).join(', ')})`
        : `  heading:   front-matter running head left as-is: ${head.reason}`
    );

    // ---- table of contents, stage 1: styles + skeleton --------------------
    const stylesPath = path.join(work, 'word/styles.xml');
    const tocStyles = injectTocStyles(fs.readFileSync(stylesPath, 'utf8'), spec);
    fs.writeFileSync(stylesPath, tocStyles.xml);

    const headings = collectTocHeadings(head.xml, spec);
    const wantPages = tocPageNumbers === 'auto';
    let doc = replaceTocField(
      head.xml,
      buildTocField(headings, spec, { pageNumbers: wantPages })
    ).xml;

    // The field is live but no longer advertised as stale, so Word shows the
    // cache instead of a modal. Do this BEFORE the oracle: the oracle opens
    // this very file, and the modal is exactly what would hang it.
    const settingsPath = path.join(work, 'word/settings.xml');
    const hasSettings = fs.existsSync(settingsPath);
    const flags = stripFieldRefreshFlags(
      doc,
      hasSettings ? fs.readFileSync(settingsPath, 'utf8') : ''
    );
    doc = flags.doc;
    if (hasSettings) fs.writeFileSync(settingsPath, flags.settings);
    fs.writeFileSync(docPath, doc);

    const byLevel = [1, 2, 3].map((l) => headings.filter((h) => h.level === l).length);
    log(
      `  toc:       ${headings.length} entries (${byLevel.join('/')} by level), ` +
        `styles ${[...tocStyles.injected, ...tocStyles.replaced].join(' ')}, ` +
        `cleared ${flags.dirty} w:dirty + ${flags.updates} w:updateFields`
    );

    // ---- table of contents, stages 2 and 3: real page numbers -------------
    let toc = { pageNumbers: false, oracleMs: null, warning: null, rebuilt: false };
    if (wantPages) {
      // The oracle needs a real file to open. Zip the skeleton to scratch, not
      // over `target`: the shipped path is written exactly once, at the end, so
      // a Word failure can never leave a half-finished book behind.
      const skeleton = path.join(work, '..', `${path.basename(work)}-skeleton.docx`);
      try {
        rezip(work, skeleton);
        toc = fillTocPageNumbers({
          work,
          skeletonPath: skeleton,
          headings,
          spec,
          oracle:
            tocOracle ||
            // Lazy: this pulls in the AppleScript machinery, and the unit tests
            // (and any Linux caller passing tocPageNumbers:'never') must not.
            //
            // 300s, not the library's 900s default. Measured range for this
            // book is 5-65s (65 was Word contended with a concurrent render),
            // so 300 is ~5x the worst real case. The point of the shorter
            // budget is the failure mode: a WEDGED Word - the normal failure
            // here, see sweepStaleStage() - should cost the build five minutes
            // and a warning, not a quarter of an hour.
            ((i, o) => require('./docx-render.js').updateTocCache(i, o, { timeoutMs: 300000 })),
          log,
        });
      } finally {
        fs.rmSync(skeleton, { force: true });
      }
    } else {
      toc.warning =
        "tocPageNumbers:'never' was requested, so the Contents ships without page numbers";
    }

    const abs = rezip(work, target);

    return {
      docxPath: abs,
      sections: sect.inserted,
      removed: sect.removed,
      levels: num.levels,
      bullets: num.bullets,
      ordered: num.ordered,
      bytes: fs.statSync(abs).size,
      contentsHeader: { applied: head.applied, reason: head.reason },
      toc: {
        entries: headings.length,
        byLevel,
        styles: [...tocStyles.injected, ...tocStyles.replaced],
        dirtyCleared: flags.dirty,
        updateFieldsCleared: flags.updates,
        ...toc,
      },
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
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

// ===========================================================================
// CLI
// ===========================================================================

if (require.main === module) {
  const argv = process.argv.slice(2);
  const files = argv.filter((a) => !a.startsWith('-'));
  const vi = argv.indexOf('--variant');
  const variant = vi === -1 ? null : argv[vi + 1];
  const files2 = files.filter((f) => f !== variant);

  if (files2.length !== 1 || !variant) {
    console.error(
      'usage: docx-postprocess.js <file.docx> --variant digital|print [--no-toc-pages]\n' +
        '  --no-toc-pages  skip the Word page-number oracle and ship a Contents\n' +
        '                  with working links but no page numbers'
    );
    process.exit(2);
  }
  try {
    const r = postProcessDocx({
      docxPath: files2[0],
      variant,
      tocPageNumbers: argv.includes('--no-toc-pages') ? 'never' : 'auto',
      log: (m) => console.log(m),
    });
    if (r.toc.warning) console.warn(`  WARNING: TOC page numbers: ${r.toc.warning}`);
    console.log(`  wrote ${r.docxPath} (${(r.bytes / 1024).toFixed(1)} KiB)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  postProcessDocx,
  insertChapterSections,
  patchNumbering,
  buildChapterSectPr,
  findBodySectPr,
  breakParagraph,
  // table of contents
  TOC_STYLE_IDS,
  TOC_HEADING_TEXT,
  CONTENTS_HEADER_PARTS,
  styleRefToLiteral,
  applyContentsHeader,
  tocStyleXml,
  injectTocStyles,
  findTocField,
  collectTocHeadings,
  buildTocField,
  replaceTocField,
  readTocPageNumbers,
  stripFieldRefreshFlags,
};
