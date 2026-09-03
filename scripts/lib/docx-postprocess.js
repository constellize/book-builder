#!/usr/bin/env node

/**
 * docx-postprocess.js — the two fixes that CANNOT live in the reference doc.
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
 * two things cannot be, and the reasons are different for each:
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
 * ---------------------------------------------------------------------------
 * IDEMPOTENCE
 * ---------------------------------------------------------------------------
 * Both patches are safe to re-run. Section breaks are removed and re-inserted
 * rather than appended to, and the numbering patch overwrites rather than
 * accumulates, so N runs produce the same bytes as one. `--check` asserts it.
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
// package round-trip
// ===========================================================================

/**
 * Unzip, patch, re-zip. In place unless `outPath` is given.
 *
 * @param {object} opts
 * @param {string} opts.docxPath .docx to process
 * @param {'digital'|'print'} opts.variant which reference doc produced it
 * @param {string} [opts.outPath] write here instead of over the input
 * @param {(msg: string) => void} [opts.log]
 * @returns {{docxPath: string, sections: number, removed: number, levels: number,
 *            bullets: number, ordered: number, bytes: number}}
 */
function postProcessDocx({ docxPath, variant, outPath, log = () => {} }) {
  const spec = styleSpec.resolve(variant);
  if (!fs.existsSync(docxPath)) {
    throw new Error(`docx-postprocess: no such file: ${docxPath}`);
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

    // Stable mtimes so re-running produces byte-identical bytes.
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

    return {
      docxPath: abs,
      sections: sect.inserted,
      removed: sect.removed,
      levels: num.levels,
      bullets: num.bullets,
      ordered: num.ordered,
      bytes: fs.statSync(abs).size,
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
    console.error('usage: docx-postprocess.js <file.docx> --variant digital|print');
    process.exit(2);
  }
  try {
    const r = postProcessDocx({
      docxPath: files2[0],
      variant,
      log: (m) => console.log(m),
    });
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
};
