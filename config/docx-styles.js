'use strict';

/**
 * docx-styles.js — declarative style/geometry spec for the pandoc reference.docx files.
 *
 * Consumed by scripts/build-reference-docx.js. This module contains NO file I/O and
 * NO XML surgery; it is pure data plus small string builders, so it can be required
 * and inspected in isolation.
 *
 * ---------------------------------------------------------------------------
 * WHY A SHARED CORE PLUS THIN DELTAS
 * ---------------------------------------------------------------------------
 * The digital and print reference docs are ~90% identical. Expressing them as two
 * parallel documents guarantees they drift. Instead everything lives in `shared`
 * and each variant contributes only a small delta, merged by `resolve()`. If a
 * value is not in a variant's delta it is *structurally impossible* for the two
 * outputs to disagree about it.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE — every number below is traced to a real source file
 * ---------------------------------------------------------------------------
 * templates/book-{digital,print}.latex (both identical on these points):
 *   \documentclass[twoside,openright,11pt]{book}
 *   \usepackage[letterpaper,margin=1in,bindingoffset=0.2in]{geometry}
 *   \titleformat{\chapter}[display]{\normalfont\huge\bfseries}{...}{20pt}{\Huge}
 *   \titleformat{\section}{\normalfont\Large\bfseries}{\thesection}{1em}{}
 *   \pagestyle{fancy} \fancyhf{}
 *   \fancyhead[LE,RO]{\thepage}
 *   \fancyhead[LO]{\nouppercase{\leftmark}}    % chapter, on recto
 *   \fancyhead[RE]{\nouppercase{\rightmark}}   % section, on verso
 *   \renewcommand{\headrulewidth}{0.4pt}
 *
 * config/pandoc-defaults-{digital,print}.yaml (both identical on these points):
 *   documentclass: book; classoption: [twoside, openright, 11pt]
 *   fontsize: 11pt; linestretch: 1.2; indent: true
 *   toc: true; toc-depth: 3; number-sections: true
 *   linkcolor: black; urlcolor: blue; citecolor: blue; toccolor: black
 *
 * ---------------------------------------------------------------------------
 * UNITS
 * ---------------------------------------------------------------------------
 *   w:sz, w:szCs                 half-points   (22 = 11pt)
 *   w:sz on border elements      eighth-points (4 = 0.5pt)
 *   everything else              twips         (1440 = 1 inch)
 *
 * @module config/docx-styles
 */

// ---------------------------------------------------------------------------
// Font identity
// ---------------------------------------------------------------------------

/**
 * Family names as they appear in the TTF `name` table (IDs 16/1). Both Atkinson
 * families are clean 4-style RIBBI families, so a single `w:ascii` name resolves
 * Regular/Bold/Italic/BoldItalic correctly without per-face naming tricks.
 */
const FONTS = {
  sans: 'Atkinson Hyperlegible Next',
  mono: 'Atkinson Hyperlegible Mono',
  /**
   * Neither Atkinson family contains box-drawing (U+2500-257F), checkmarks or
   * arrows. This is the docx analogue of the \newunicodechar block at
   * book-digital.latex:47-63, which redirects those code points to Menlo.
   * Consolas ships with Office on both Windows and macOS and covers box-drawing.
   */
  symbolFallback: 'Consolas',
};

/**
 * Faces to embed, in `word/fonts/` part order. `file` is relative to fonts/.
 * `style` is font-embed's vocabulary (regular | bold | italic | boldItalic) and
 * maps onto the w:embedRegular / w:embedBold / w:embedItalic / w:embedBoldItalic
 * elements of fontTable.xml.
 *
 * These are exactly the four faces per family that book.config.js and the
 * \setmainfont / \setmonofont declarations name as in use. The other 24 TTFs in
 * fonts/ (Light, Medium, SemiBold, ExtraBold ...) are deliberately NOT embedded:
 * nothing references them, and each one costs ~30 KB in every output file.
 *
 * NOTE: no PANOSE / OS-2 signature is hardcoded here on purpose. font-embed.js
 * reads the real values out of the TTFs at build time. A second, hand-copied set
 * of those bytes in this file would be a drift hazard with no upside.
 */
const EMBED_FAMILIES = [
  {
    name: FONTS.sans,
    stem: 'AtkinsonHyperlegibleNext',
    faces: [
      { style: 'regular', file: 'AtkinsonHyperlegibleNext-Regular.ttf' },
      { style: 'bold', file: 'AtkinsonHyperlegibleNext-Bold.ttf' },
      { style: 'italic', file: 'AtkinsonHyperlegibleNext-RegularItalic.ttf' },
      { style: 'boldItalic', file: 'AtkinsonHyperlegibleNext-BoldItalic.ttf' },
    ],
  },
  {
    name: FONTS.mono,
    stem: 'AtkinsonHyperlegibleMono',
    faces: [
      { style: 'regular', file: 'AtkinsonHyperlegibleMono-Regular.ttf' },
      { style: 'bold', file: 'AtkinsonHyperlegibleMono-Bold.ttf' },
      { style: 'italic', file: 'AtkinsonHyperlegibleMono-RegularItalic.ttf' },
      { style: 'boldItalic', file: 'AtkinsonHyperlegibleMono-BoldItalic.ttf' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const TWIPS_PER_INCH = 1440;

/** US Letter, from `letterpaper`. */
const PAGE = { width: 12240, height: 15840 };

/** `margin=1in`. */
const MARGIN = 1440;

/**
 * `bindingoffset=0.2in` -> w:gutter.
 *
 * BOTH variants. book-digital.latex and book-print.latex carry the identical
 * `\usepackage[letterpaper,margin=1in,bindingoffset=0.2in]{geometry}` line, so a
 * digital docx with gutter 0 would not be the same book as the digital PDF. The
 * docx exists to hand a typesetter a file that reproduces the LaTeX layout; a
 * "nicer on screen" departure defeats that.
 */
const GUTTER = 288;

/**
 * `w:type` of every section break in the document, matching `openright`.
 *
 * `oddPage` starts the section on the next odd (recto) page, inserting a blank
 * verso when needed — exactly \cleardoublepage. See CHAPTER_BREAK_STYLES for why
 * this alone is not enough.
 */
const SECTION_TYPE = 'oddPage';

/**
 * Paragraph styles whose every occurrence must open a new odd-page section.
 *
 * WHY THIS EXISTS AT ALL. `w:type` is a property of a *section*, and pandoc emits
 * exactly ONE section for the whole document (measured: 1 `<w:sectPr>` in the
 * output of a five-chapter conversion). So the `oddPage` in the reference doc's
 * body sectPr applies once, at document start, and never again. Measured before
 * the fix: chapter 2 landed on page 4, a verso. `<w:pageBreakBefore/>` on
 * Heading1 breaks to a *new* page, not to an *odd* page.
 *
 * The per-chapter mechanism lives in scripts/lib/docx-postprocess.js, which
 * inserts one section-break paragraph ahead of each of these styles. It is a
 * post-process rather than a Lua filter or a style property because:
 *
 *   - A sectPr does NOT inherit: every emitted one must repeat pgSz, pgMar
 *     (gutter included), pgNumType, titlePg and the header/footer r:ids, or the
 *     new section silently reverts to Word's defaults and the running heads
 *     vanish. The post-process CLONES the sectPr pandoc actually wrote, so the
 *     r:ids are correct by construction — there is no cross-file id contract
 *     that can drift. A Lua filter would have to reproduce those ids from a file
 *     it cannot see.
 *   - A style-level sectPr is not valid OOXML. `w:style/w:pPr` is CT_PPrGeneral
 *     (CT_PPrBase + w:pPrChange); only `w:p/w:pPr` is CT_PPr, which is the type
 *     that carries the `w:sectPr` particle. Word drops it silently.
 *   - The list-marker fix (below) already requires a post-process pass over the
 *     produced .docx, so this adds no new pipeline stage.
 *
 * `<w:pageBreakBefore/>` stays on Heading1 as a fallback for anyone converting
 * without the post-process. Measured: Word does not double-break — a Heading1
 * already sitting at the top of a fresh odd-page section paginates identically
 * with and without it (11 pages either way, chapters on 3/5/7/9/11).
 */
const CHAPTER_BREAK_STYLES = ['Heading1'];

/** Distance of header/footer from the paper edge (0.5in). */
const HEADER_FOOTER_DIST = 720;

/** Half-points. */
const SIZE = {
  body: 22, //  11pt   fontsize: 11pt
  h1: 48, //  24pt   \Huge at 11pt = 24.88pt
  h2: 28, //  14pt   \Large at 11pt = 14.4pt
  h3: 24, //  12pt   \large at 11pt = 12.1pt
  h4: 22,
  h5: 22,
  h6: 22,
  title: 56, //  28pt
  subtitle: 28, //  14pt
  code: 18, //   9pt   minted \small (10pt) x \setmonofont Scale=0.9
  headerFooter: 18, //   9pt   running heads
  caption: 20, //  10pt
  footnote: 18, //   9pt
};

/**
 * Line spacing, twips, with w:lineRule="auto" (i.e. a multiple of single).
 * 240 = single. linestretch: 1.2 -> 288.
 */
const LINE = { body: 288, tight: 240 };

/** LaTeX \parindent for book class at 11pt is ~17pt. */
const PARINDENT = 340;

/** Colors. */
const COLOR = {
  text: '000000',
  muted: '404040',
  /** xcolor `blue`, matching urlcolor=blue in the LaTeX templates. */
  link: '0000FF',
  rule: '000000',
  codeBg: 'F6F8FA',
  codeBorder: 'D0D7DE',
  quoteBar: 'C8CDD3',
};

// ---------------------------------------------------------------------------
// Small XML builders
// ---------------------------------------------------------------------------

/**
 * Build a `w:rFonts` element naming one family across all four script ranges.
 *
 * OOXML has NO fallback chain. ascii / hAnsi / eastAsia / cs are script-RANGE
 * selectors, not a priority list, and there is no CSS-style comma syntax.
 * Filling all four is what stops unlisted ranges silently falling back to Times
 * New Roman. Graceful degradation for glyphs the family genuinely lacks is
 * handled by the SymbolFallback character style, not by this element.
 *
 * Critically, this element carries NO `*Theme` attributes. When both `w:ascii`
 * and `w:asciiTheme` are present Word honours the theme attribute, so a patch
 * must REPLACE the whole rFonts element rather than add attributes to it.
 *
 * @param {string} name font family name
 * @param {{hint?: string}} [opts] `hint` emits `w:hint`, which tells Word which
 *   of the four script slots to use for a character it cannot classify. Only
 *   needed on list markers, where the marker is a lone symbol with no
 *   surrounding text to classify it by; omitted everywhere else so existing
 *   output stays byte-identical.
 * @returns {string} XML
 */
const rFonts = (name, opts = {}) =>
  `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:cs="${name}" w:eastAsia="${name}"` +
  (opts.hint ? ` w:hint="${opts.hint}"` : '') +
  '/>';

/**
 * Build a `w:sz`/`w:szCs` pair.
 * @param {number} halfPoints
 * @returns {string} XML
 */
const sz = (halfPoints) =>
  `<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/>`;

/**
 * Build a `w:color`. Emitted without `w:themeColor`/`w:themeShade` on purpose:
 * pandoc's baseline headings carry `w:themeColor="accent1"`, which overrides
 * `w:val` exactly the way themeFonts override `w:ascii`. Replacing the whole
 * element is what actually removes the blue.
 * @param {string} hex six hex digits, no leading '#'
 * @returns {string} XML
 */
const color = (hex) => `<w:color w:val="${hex}"/>`;

/**
 * Run properties shared by all heading levels 1-3.
 * LaTeX uses \normalfont\bfseries for chapters and sections, i.e. plain black
 * bold - not pandoc's accent1 blue (0F4761).
 * @param {number} size half-points
 * @returns {string} XML
 */
const headingRPr = (size) =>
  `${rFonts(FONTS.sans)}<w:b/><w:bCs/>${color(COLOR.text)}${sz(size)}`;

/**
 * Run properties for every titling paragraph style, defined ONCE and applied to
 * both the paragraph style and its linked `*Char` character style.
 *
 * This pairing is not cosmetic. pandoc's reference.docx defines Heading1Char
 * with `w:asciiTheme="majorHAnsi"`, `w:themeColor="accent1"` and `w:sz="40"`
 * (20pt) - i.e. the theme font, the Office blue, and a size that disagrees with
 * the 24pt we set on Heading1 itself. A character style BEATS its paragraph
 * style, so any run carrying Heading1Char would render blue at the wrong size
 * while the surrounding paragraph looked correct. Deriving both from one entry
 * here makes that class of drift structurally impossible.
 */
const TITLING_RPR = {
  Heading1: headingRPr(SIZE.h1),
  Heading2: headingRPr(SIZE.h2),
  Heading3: headingRPr(SIZE.h3),
  // Levels 4-9 keep pandoc's own emphasis (H4/H6/H8 are italic); the merge only
  // swaps the font and the colour, so those are inherited rather than restated.
  Heading4: `${rFonts(FONTS.sans)}${color(COLOR.text)}`,
  Heading5: `${rFonts(FONTS.sans)}${color(COLOR.text)}`,
  Heading6: `${rFonts(FONTS.sans)}${color(COLOR.muted)}`,
  Heading7: `${rFonts(FONTS.sans)}${color(COLOR.muted)}`,
  Heading8: `${rFonts(FONTS.sans)}${color(COLOR.muted)}`,
  Heading9: `${rFonts(FONTS.sans)}${color(COLOR.muted)}`,
  Title: `${rFonts(FONTS.sans)}<w:b/><w:bCs/>${color(COLOR.text)}${sz(SIZE.title)}`,
  Subtitle: `${rFonts(FONTS.sans)}${color(COLOR.muted)}${sz(SIZE.subtitle)}`,
};

/**
 * Paragraph properties shared by all heading levels.
 *
 * The tab stop matters: with `number-sections: true` pandoc emits a heading as
 * [run:SectionNumber "1.1"][run:<w:tab/>][run "Title"]. Without an explicit stop
 * that tab jumps to w:defaultTabStop, which is far too wide. 360 twips (0.25in)
 * approximates the `{1em}` separation in \titleformat{\section}.
 *
 * @param {object} opts
 * @param {number} opts.before space before, twips
 * @param {number} opts.after space after, twips
 * @param {number} opts.level 0-based outline level
 * @param {boolean} [opts.pageBreak] start the heading on a new page
 * @returns {string} XML
 */
const headingPPr = ({ before, after, level, pageBreak = false }) =>
  '<w:pPr>' +
  '<w:keepNext/><w:keepLines/>' +
  (pageBreak ? '<w:pageBreakBefore/>' : '') +
  '<w:widowControl/>' +
  '<w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs>' +
  `<w:spacing w:before="${before}" w:after="${after}" w:line="${LINE.tight}" w:lineRule="auto"/>` +
  '<w:ind w:firstLine="0"/>' +
  `<w:outlineLvl w:val="${level}"/>` +
  '</w:pPr>';

// ---------------------------------------------------------------------------
// List markers
// ---------------------------------------------------------------------------

/**
 * Bullet and number markers for word/numbering.xml.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A REFERENCE-DOC SETTING
 * ---------------------------------------------------------------------------
 * pandoc READS AND DISCARDS the reference doc's numbering.xml, then synthesises
 * its own from scratch at write time. Measured: markers injected into a
 * reference doc's `abstractNum` 990 and 991 — a tampered `nsid`, a tampered
 * `lvlText`, a tampered `rFonts`, and a whole extra `abstractNum` — were ALL
 * absent from the output, along with pandoc's own original `nsid`. A Lua filter
 * cannot reach it either: numbering.xml is generated by the writer, downstream
 * of the AST, and the AST carries no marker-font attribute. Hence
 * scripts/lib/docx-postprocess.js, which patches the produced .docx.
 *
 * What pandoc generates, and what is wrong with it:
 *   ilvl 0/3/6  lvlText U+F0B7  rFonts Symbol       <- private-use area
 *   ilvl 1/4/7  lvlText "o"     rFonts Courier New
 *   ilvl 2/5/8  lvlText U+F0A7  rFonts Wingdings
 * i.e. three foreign fonts in a book that embeds Atkinson precisely so it can
 * be reproduced anywhere. Measured with pdffonts on a real Word render:
 * SymbolMT + CourierNewPSMT present before the patch, gone after.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE THREE CHARACTERS
 * ---------------------------------------------------------------------------
 * Verified with fontTools against all 8 embedded faces (Next and Mono, all four
 * styles each): U+2022, U+2013 and U+00B7 are present in every one, with real
 * outlines. So no substitution and no visual compromise — U+2022 is the
 * canonical typographic bullet, and exactly the glyph Word's Symbol-font U+F0B7
 * is imitating.
 *
 * The tiers track LaTeX's own `itemize` labels, which are
 * \textbullet / \textendash / \textasteriskcentered / \textperiodcentered.
 * Tier 3 uses U+00B7 rather than the asterisk operator because U+2217 is the one
 * of those four that Atkinson does NOT contain (verified absent in all 8 faces),
 * and faking it with a fallback font is what this whole patch exists to remove.
 *
 * Word's own nesting cycle (filled / hollow o / square) is not reproducible:
 * Atkinson has no U+25E6, U+25CB, U+25AA or U+25CF. That is the only real
 * constraint here, and it costs nothing — indentation already conveys depth.
 *
 * Numbered lists need no character list: digits, '.', '(' and ')' are all in
 * Atkinson. pandoc emits ordered levels with NO `w:rPr` at all, so their markers
 * merely inherit; Word happened to resolve that to Atkinson already, LibreOffice
 * substituted. Writing the font explicitly makes both deterministic.
 */
const LIST_MARKERS = {
  /** Marker typeface. Body font, so markers match the text they introduce. */
  font: FONTS.sans,
  /**
   * Cycled over the nine `w:ilvl` values (0-8), exactly the way pandoc cycles
   * its own three. Index = ilvl % bullets.length.
   */
  bullets: ['•', '–', '·'],
};

// ---------------------------------------------------------------------------
// theme1.xml
// ---------------------------------------------------------------------------

/**
 * Theme font scheme. MANDATORY, not an optimisation.
 *
 * pandoc emits a `TOC \o "1-3" \h \z \u` field but defines no TOC1/TOC2/TOC3
 * styles - neither does its reference.docx. Word materialises those styles from
 * its built-in gallery when it updates the field, and they resolve their font
 * through `minorHAnsi`, i.e. through the theme. No edit to styles.xml can style
 * a style that does not exist yet, so without this patch the entire table of
 * contents renders in Aptos.
 */
const THEME = {
  majorLatin: FONTS.sans,
  minorLatin: FONTS.sans,
};

// ---------------------------------------------------------------------------
// docDefaults
// ---------------------------------------------------------------------------

/**
 * Document-wide defaults. Everything in pandoc's baseline routes its font
 * through `w:asciiTheme="minorHAnsi"`, so the rFonts element is replaced whole.
 */
const DOC_DEFAULTS = {
  rPr:
    `${rFonts(FONTS.sans)}${sz(SIZE.body)}` +
    '<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/>',
  pPr:
    '<w:widowControl/>' +
    `<w:spacing w:after="0" w:line="${LINE.body}" w:lineRule="auto"/>`,
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * Style patches keyed by w:styleId.
 *
 * Each entry uses exactly one strategy:
 *   `replace`  - overwrite the whole <w:style> body (style must exist already)
 *   `create`   - style is absent from pandoc's reference.docx; append it
 *   `patchPPr` / `patchRPr` - merge element-by-element into the existing
 *                block, replacing same-named elements and keeping the rest
 *
 * HEADINGS DELIBERATELY CARRY NO <w:numPr>. pandoc writes section numbers as
 * static literal text in a SectionNumber-styled run. Attaching Word outline
 * numbering on top produces "2  1  Foundations" - every heading numbered twice.
 *
 * There are intentionally NO callout styles here. The callouts are self-contained
 * raw OpenXML tables emitted by the Lua filters with their own inline formatting;
 * they reference no named style, so any Callout* style would be dead XML.
 */
const STYLES = {
  // ---- headings ----------------------------------------------------------
  Heading1: {
    replace: true,
    body:
      '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/>' +
      '<w:link w:val="Heading1Char"/><w:uiPriority w:val="9"/><w:qFormat/>' +
      headingPPr({ before: 0, after: 400, level: 0, pageBreak: true }) +
      `<w:rPr>${TITLING_RPR.Heading1}</w:rPr>`,
  },

  Heading2: {
    replace: true,
    body:
      '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/>' +
      '<w:link w:val="Heading2Char"/><w:uiPriority w:val="9"/><w:qFormat/>' +
      headingPPr({ before: 360, after: 120, level: 1 }) +
      `<w:rPr>${TITLING_RPR.Heading2}</w:rPr>`,
  },

  Heading3: {
    replace: true,
    body:
      '<w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/>' +
      '<w:link w:val="Heading3Char"/><w:uiPriority w:val="9"/><w:qFormat/>' +
      headingPPr({ before: 280, after: 100, level: 2 }) +
      `<w:rPr>${TITLING_RPR.Heading3}</w:rPr>`,
  },

  // Heading4-9 keep pandoc's spacing and emphasis; only the themed font and the
  // accent1 blue are overridden. (The merge replaces w:rFonts and w:color as
  // whole elements, which is what strips w:asciiTheme and w:themeColor.)
  Heading4: { patchRPr: TITLING_RPR.Heading4 },
  Heading5: { patchRPr: TITLING_RPR.Heading5 },
  Heading6: { patchRPr: TITLING_RPR.Heading6 },
  Heading7: { patchRPr: TITLING_RPR.Heading7 },
  Heading8: { patchRPr: TITLING_RPR.Heading8 },
  Heading9: { patchRPr: TITLING_RPR.Heading9 },

  Title: { patchRPr: TITLING_RPR.Title },
  Subtitle: { patchRPr: TITLING_RPR.Subtitle },

  TOCHeading: {
    replace: true,
    body:
      '<w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="BodyText"/>' +
      '<w:uiPriority w:val="39"/><w:qFormat/>' +
      // outlineLvl 9 = body level: keeps "Contents" itself out of the TOC.
      '<w:pPr><w:pageBreakBefore/><w:outlineLvl w:val="9"/></w:pPr>' +
      `<w:rPr>${TITLING_RPR.Heading1}</w:rPr>`,
  },

  // ---- body --------------------------------------------------------------
  // `indent: true` in the defaults yaml means LaTeX \parindent paragraphs.
  // Only BlockText, Compact and FirstParagraph inherit from BodyText, and all
  // three zero the indent below, so the blast radius is fully accounted for.
  BodyText: {
    replace: true,
    body:
      '<w:name w:val="Body Text"/><w:basedOn w:val="Normal"/>' +
      '<w:link w:val="BodyTextChar"/><w:qFormat/>' +
      '<w:pPr><w:widowControl/>' +
      `<w:spacing w:before="0" w:after="0" w:line="${LINE.body}" w:lineRule="auto"/>` +
      `<w:ind w:firstLine="${PARINDENT}"/></w:pPr>`,
  },

  // pandoc applies FirstParagraph to the paragraph directly after a heading,
  // which is exactly where LaTeX suppresses \parindent.
  FirstParagraph: {
    replace: true,
    body:
      '<w:name w:val="First Paragraph"/><w:basedOn w:val="BodyText"/>' +
      '<w:next w:val="BodyText"/><w:qFormat/>' +
      '<w:pPr><w:ind w:firstLine="0"/></w:pPr>',
  },

  // Compact is used for list items and table cells. It MUST zero the inherited
  // first-line indent or every bullet gets an extra 17pt of hanging text.
  Compact: {
    replace: true,
    body:
      '<w:name w:val="Compact"/><w:basedOn w:val="BodyText"/><w:qFormat/>' +
      `<w:pPr><w:spacing w:before="36" w:after="36" w:line="${LINE.tight}" w:lineRule="auto"/>` +
      '<w:ind w:firstLine="0"/></w:pPr>',
  },

  BlockText: {
    replace: true,
    body:
      '<w:name w:val="Block Text"/><w:basedOn w:val="BodyText"/>' +
      '<w:next w:val="BodyText"/><w:qFormat/>' +
      '<w:pPr>' +
      `<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="${COLOR.quoteBar}"/></w:pBdr>` +
      '<w:spacing w:before="120" w:after="120"/>' +
      '<w:ind w:left="480" w:right="480" w:firstLine="0"/>' +
      '</w:pPr><w:rPr><w:i/><w:iCs/></w:rPr>',
  },

  Bibliography: {
    replace: true,
    body:
      '<w:name w:val="Bibliography"/><w:basedOn w:val="BodyText"/>' +
      '<w:next w:val="Bibliography"/><w:qFormat/>' +
      '<w:pPr><w:spacing w:before="0" w:after="120"/>' +
      '<w:ind w:left="480" w:hanging="480"/></w:pPr>',
  },

  FootnoteText: {
    replace: true,
    body:
      '<w:name w:val="Footnote Text"/><w:basedOn w:val="Normal"/>' +
      '<w:next w:val="FootnoteText"/><w:uiPriority w:val="9"/><w:qFormat/>' +
      '<w:pPr><w:widowControl/>' +
      `<w:spacing w:before="0" w:after="40" w:line="${LINE.tight}" w:lineRule="auto"/>` +
      '<w:ind w:firstLine="0"/></w:pPr>' +
      `<w:rPr>${sz(SIZE.footnote)}</w:rPr>`,
  },

  Caption: {
    patchPPr:
      '<w:spacing w:before="0" w:after="120"/><w:ind w:firstLine="0"/><w:jc w:val="center"/>',
    patchRPr: `<w:i/><w:iCs/>${sz(SIZE.caption)}`,
  },
  ImageCaption: {
    replace: true,
    body:
      '<w:name w:val="Image Caption"/><w:basedOn w:val="Caption"/>' +
      '<w:pPr><w:keepNext w:val="0"/></w:pPr>',
  },
  CaptionedFigure: {
    replace: true,
    body:
      '<w:name w:val="Captioned Figure"/><w:basedOn w:val="Figure"/>' +
      '<w:pPr><w:keepNext/><w:spacing w:before="120" w:after="60"/>' +
      '<w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr>',
  },

  // ---- code --------------------------------------------------------------
  /**
   * VerbatimChar is the SINGLE SOURCE OF TRUTH for code font and code size.
   *
   * Every *Tok style pandoc generates is basedOn VerbatimChar, and every run
   * inside a SourceCode paragraph carries a *Tok character style. Character
   * style beats paragraph style, so a w:sz on SourceCode does NOT reach the
   * code text - only this does.
   */
  VerbatimChar: {
    replace: true,
    body:
      '<w:name w:val="Verbatim Char"/><w:basedOn w:val="BodyTextChar"/>' +
      `<w:rPr>${rFonts(FONTS.mono)}${sz(SIZE.code)}</w:rPr>`,
  },

  /**
   * SourceCode is ABSENT from pandoc's reference.docx. pandoc synthesises a bare
   * version (no font, no size, no shading) only when the reference doc lacks it;
   * defining it here makes pandoc use ours verbatim, exactly once.
   */
  SourceCode: {
    create: true,
    type: 'paragraph',
    body:
      '<w:name w:val="Source Code"/><w:basedOn w:val="Normal"/>' +
      '<w:link w:val="VerbatimChar"/><w:qFormat/>' +
      '<w:pPr>' +
      '<w:keepLines/><w:widowControl/>' +
      '<w:pBdr>' +
      `<w:top w:val="single" w:sz="4" w:space="4" w:color="${COLOR.codeBorder}"/>` +
      `<w:left w:val="single" w:sz="4" w:space="4" w:color="${COLOR.codeBorder}"/>` +
      `<w:bottom w:val="single" w:sz="4" w:space="4" w:color="${COLOR.codeBorder}"/>` +
      `<w:right w:val="single" w:sz="4" w:space="4" w:color="${COLOR.codeBorder}"/>` +
      '</w:pBdr>' +
      `<w:shd w:val="clear" w:color="auto" w:fill="${COLOR.codeBg}"/>` +
      '<w:wordWrap w:val="off"/>' +
      `<w:spacing w:before="120" w:after="120" w:line="${LINE.tight}" w:lineRule="auto"/>` +
      '<w:ind w:left="240" w:right="240" w:firstLine="0"/>' +
      '</w:pPr>' +
      // Mirrored onto the paragraph mark so blank lines in a block keep height.
      `<w:rPr>${rFonts(FONTS.mono)}${sz(SIZE.code)}</w:rPr>`,
  },

  /**
   * Hook for a Lua filter to tag runs containing box-drawing or dingbat glyphs.
   * Costs nothing if unused. This is the docx counterpart of \symbolfont.
   */
  SymbolFallback: {
    create: true,
    type: 'character',
    body:
      '<w:name w:val="Symbol Fallback"/><w:basedOn w:val="VerbatimChar"/>' +
      `<w:rPr>${rFonts(FONTS.symbolFallback)}${sz(SIZE.code)}</w:rPr>`,
  },

  // ---- header/footer -----------------------------------------------------
  // Both are ABSENT from pandoc's reference.docx and must be created, or the
  // header/footer parts below would reference undefined styles.
  Header: {
    create: true,
    type: 'paragraph',
    body:
      '<w:name w:val="header"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/>' +
      `<w:pPr><w:spacing w:before="0" w:after="0" w:line="${LINE.tight}" w:lineRule="auto"/>` +
      '<w:ind w:firstLine="0"/></w:pPr>' +
      `<w:rPr>${sz(SIZE.headerFooter)}</w:rPr>`,
  },
  Footer: {
    create: true,
    type: 'paragraph',
    body:
      '<w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/>' +
      `<w:pPr><w:spacing w:before="0" w:after="0" w:line="${LINE.tight}" w:lineRule="auto"/>` +
      '<w:ind w:firstLine="0"/></w:pPr>' +
      `<w:rPr>${sz(SIZE.headerFooter)}</w:rPr>`,
  },
};

/**
 * Mirror every titling style's run properties onto its linked `*Char` character
 * style. Generated rather than written out so the pair can never disagree.
 *
 * Word keeps a paragraph style and its `w:link` partner in lockstep; leaving the
 * character half on the theme font and the accent1 blue is a latent defect that
 * only shows up once someone selects heading text, or once a filter emits a run
 * with an explicit rStyle.
 */
for (const [styleId, rPr] of Object.entries(TITLING_RPR)) {
  STYLES[`${styleId}Char`] = { patchRPr: rPr };
}

// ---------------------------------------------------------------------------
// Running heads
// ---------------------------------------------------------------------------

/**
 * Running-head layouts, mirroring fancyhdr:
 *   \fancyhead[LO]{\leftmark}  chapter title, recto, left
 *   \fancyhead[RO]{\thepage}   page number,   recto, right
 *   \fancyhead[LE]{\thepage}   page number,   verso, left
 *   \fancyhead[RE]{\rightmark} section title, verso, right
 *
 * STYLEREF matches the style NAME (w:name, e.g. "heading 1"), case-insensitively
 * - not the styleId.
 */
const RECTO_HEADER = [
  { align: 'left', field: { kind: 'styleref', styleName: 'Heading 1' }, placeholder: 'Chapter' },
  { align: 'right', field: { kind: 'page' }, placeholder: '1' },
];
const VERSO_HEADER = [
  { align: 'left', field: { kind: 'page' }, placeholder: '1' },
  { align: 'right', field: { kind: 'styleref', styleName: 'Heading 2' }, placeholder: 'Section' },
];

/**
 * Header and footer parts. BOTH variants, because both LaTeX templates set
 * `classoption: [twoside, openright]` and the same \fancyhead block: a recto
 * layout, a mirrored verso layout, and a blank `first` part for the title page
 * and every chapter opening (\thispagestyle{plain}).
 *
 * The `first` part is what makes titlePg meaningful. Each chapter section
 * carries titlePg, so a chapter's opening page draws this blank part instead of
 * a running head — which is what the book class does at \chapter.
 */
const HEADERS = [
  { type: 'default', file: 'header1.xml', cells: RECTO_HEADER },
  { type: 'even', file: 'header2.xml', cells: VERSO_HEADER },
  { type: 'first', file: 'header3.xml', cells: null },
];
const FOOTERS = [
  { type: 'default', file: 'footer1.xml', cells: null },
  { type: 'even', file: 'footer2.xml', cells: null },
];

// ---------------------------------------------------------------------------
// Shared spec
// ---------------------------------------------------------------------------

/**
 * Everything both variants agree on. A variant delta may only override keys
 * listed in VARIANT_KEYS below; any key it does not override is taken from here.
 */
const shared = {
  fonts: FONTS,
  embedFamilies: EMBED_FAMILIES,
  page: PAGE,
  margin: MARGIN,
  headerFooterDist: HEADER_FOOTER_DIST,
  size: SIZE,
  line: LINE,
  parIndent: PARINDENT,
  color: COLOR,
  theme: THEME,
  docDefaults: DOC_DEFAULTS,
  styles: STYLES,
  listMarkers: LIST_MARKERS,

  // ---- page geometry and section behaviour --------------------------------
  // All of this used to be per-variant. It is shared now because both LaTeX
  // templates declare the same geometry and the same twoside/openright class
  // options; see GUTTER and SECTION_TYPE above.
  gutter: GUTTER,
  sectionType: SECTION_TYPE,
  chapterBreakStyles: CHAPTER_BREAK_STYLES,
  mirrorMargins: true,
  evenAndOddHeaders: true,
  headers: HEADERS,
  footers: FOOTERS,

  /** Width of the page-number cell in the running-head table, twips. */
  pageNumberCellWidth: 1361,

  /** Header rule: \renewcommand{\headrulewidth}{0.4pt}; w:sz is eighth-points. */
  headRuleSize: 4,

  /**
   * settings.xml flags applied to both variants, with their verified insertion
   * anchors. CT_Settings is an ordered sequence, so these are not free-floating.
   */
  settingsCommon: [
    // Without this Word discards word/fonts/ on the first re-save.
    { xml: '<w:embedTrueTypeFonts/>', before: 'w:embedSystemFonts' },
    // false => ship complete faces, not subsets, so the doc stays editable.
    { xml: '<w:saveSubsetFonts w:val="false"/>', after: 'w:embedSystemFonts' },
    /*
     * The standards-correct request to refresh fields (TOC page numbers) on
     * open. Kept because it is the documented signal and costs nothing, but do
     * NOT rely on it: measured against Word 16.112 and LibreOffice 26.8, it is
     * inert in both.
     *
     *   Word  - prompts "This document contains fields that may refer to other
     *           files. Update?" whether or not this flag is present (the prompt
     *           is driven by the presence of TOC/STYLEREF/PAGE fields plus the
     *           user's "update automatic links at open" preference). Clicking
     *           No leaves the TOC empty even WITH this flag set; clicking Yes
     *           populates it even without.
     *   LO     - headless conversion ignores it entirely; the TOC stays empty.
     *
     * pandoc emits the TOC field with no cached result, so an un-refreshed TOC
     * renders as just the "Table of Contents" heading. Producing a populated
     * TOC without user interaction needs the field result to be written into
     * document.xml, which is a Lua-filter/post-process job, not a settings flag.
     */
    { xml: '<w:updateFields w:val="true"/>', after: 'w:savePreviewPicture' },
  ],
};

/**
 * Keys a variant delta is permitted to define. Anything else is a typo.
 *
 * This is deliberately WIDER than what the two variants currently use. Every key
 * here has a value in `shared`; listing it means "a variant may legitimately
 * override this", not "a variant does". Today only `styleOverrides` is used, on
 * top of the mandatory `id` / `description`.
 */
const VARIANT_KEYS = new Set([
  'id',
  'description',
  'gutter',
  'sectionType',
  'chapterBreakStyles',
  'mirrorMargins',
  'evenAndOddHeaders',
  'listMarkers',
  'styleOverrides',
  'headers',
  'footers',
]);

// ---------------------------------------------------------------------------
// Variant deltas
// ---------------------------------------------------------------------------

/**
 * Hyperlink style. Split out because it is the one *style* that differs between
 * targets: on screen a link should look like a link; in print, coloured
 * underlined text is just noise on paper.
 * @param {{color: string, underline: boolean}} opts
 * @returns {string} XML style body
 */
const hyperlinkStyle = ({ color: hex, underline }) =>
  '<w:name w:val="Hyperlink"/><w:basedOn w:val="BodyTextChar"/>' +
  '<w:uiPriority w:val="99"/>' +
  `<w:rPr>${color(hex)}<w:u w:val="${underline ? 'single' : 'none'}"/></w:rPr>`;

/**
 * ---------------------------------------------------------------------------
 * WHAT ACTUALLY DIFFERS BETWEEN THE TWO VARIANTS: THE HYPERLINK STYLE. THAT IS
 * THE WHOLE LIST.
 * ---------------------------------------------------------------------------
 * The digital reference doc used to be single-sided — gutter 0, no mirrored
 * margins, no even-page headers, no oddPage section type. That was a departure
 * from book-digital.latex, which carries the identical
 * `classoption: [twoside, openright]` and the identical
 * `bindingoffset=0.2in` as book-print.latex. The docx exists so the book can be
 * regenerated from source for a typesetter, so it has to be the same book as the
 * PDF; a screen-friendly variation is a different book.
 *
 * The hyperlink delta survives because it tracks something the LaTeX templates
 * genuinely disagree about: `urlcolor: blue` is honoured on screen, where a link
 * should look clickable, while on paper a blue underline is ink spent on
 * something nobody can click.
 *
 * Anything not listed in a delta comes from `shared`, so the two outputs are
 * structurally incapable of disagreeing about it.
 */
const digital = {
  id: 'digital',
  description:
    'Screen reading: twoside/openright, 0.2in binding gutter, visible blue links.',
  styleOverrides: {
    Hyperlink: {
      replace: true,
      body: hyperlinkStyle({ color: COLOR.link, underline: true }),
    },
  },
};

const print = {
  id: 'print',
  description:
    'Offset print: twoside/openright, 0.2in binding gutter, ink-only links.',
  styleOverrides: {
    Hyperlink: {
      replace: true,
      body: hyperlinkStyle({ color: 'auto', underline: false }),
    },
  },
};

const VARIANTS = { digital, print };

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Merge `shared` with one variant's delta into a complete, self-consistent spec.
 *
 * This is the only supported way to read the config. Because variants carry only
 * deltas, any value absent from a delta is guaranteed identical across targets -
 * digital and print cannot drift on it.
 *
 * @param {'digital'|'print'} name
 * @returns {object} fully resolved spec
 * @throws {Error} on an unknown variant or an unrecognised delta key
 */
function resolve(name) {
  const variant = VARIANTS[name];
  if (!variant) {
    throw new Error(
      `docx-styles: unknown variant ${JSON.stringify(name)}; ` +
        `expected one of ${Object.keys(VARIANTS).join(', ')}`
    );
  }

  // Fail loudly on a delta key that resolve() would otherwise silently drop.
  for (const key of Object.keys(variant)) {
    if (!VARIANT_KEYS.has(key)) {
      throw new Error(
        `docx-styles: variant "${name}" declares unknown key ${JSON.stringify(key)}; ` +
          `allowed: ${[...VARIANT_KEYS].join(', ')}`
      );
    }
  }

  for (const key of ['id', 'description']) {
    if (typeof variant[key] !== 'string' || !variant[key]) {
      throw new Error(`docx-styles: variant "${name}" is missing a ${key}`);
    }
  }

  // Every style override must target a style the shared map or the pandoc
  // baseline actually knows about; a typo here would be inert XML.
  const styles = { ...shared.styles };
  for (const [id, patch] of Object.entries(variant.styleOverrides || {})) {
    styles[id] = patch;
  }

  // A key absent from the delta falls through to `shared`. That fall-through is
  // the whole point: it is what makes drift between the variants impossible
  // rather than merely unlikely.
  const merged = { ...shared, ...variant };
  delete merged.styleOverrides;

  const textWidth = PAGE.width - 2 * MARGIN - merged.gutter;
  const pageNumberCellWidth = shared.pageNumberCellWidth;

  return {
    ...merged,
    styles,
    textWidth,
    /** Running-head table columns: [title column, page-number column]. */
    headerColumns: {
      pageNumber: pageNumberCellWidth,
      title: textWidth - pageNumberCellWidth,
    },
    /**
     * Extra settings.xml flags this variant needs, on top of settingsCommon.
     * Read from `merged`, not from `variant`: these are shared values now, and
     * reading the raw delta would silently emit neither.
     */
    settingsExtra: [
      merged.mirrorMargins
        ? // NOT a sectPr child. In sectPr it is silently ignored; only in
          // settings.xml does it actually mirror the inner/outer margins.
          { xml: '<w:mirrorMargins/>', after: 'w:saveSubsetFonts' }
        : null,
      merged.evenAndOddHeaders
        ? { xml: '<w:evenAndOddHeaders/>', after: 'w:defaultTabStop' }
        : null,
    ].filter(Boolean),
  };
}

module.exports = {
  shared,
  digital,
  print,
  VARIANTS,
  resolve,
  // Primitives, exported for tests and for any other tooling that needs them.
  FONTS,
  EMBED_FAMILIES,
  TWIPS_PER_INCH,
  PAGE,
  MARGIN,
  GUTTER,
  SECTION_TYPE,
  CHAPTER_BREAK_STYLES,
  HEADER_FOOTER_DIST,
  SIZE,
  LINE,
  PARINDENT,
  COLOR,
  LIST_MARKERS,
  THEME,
  DOC_DEFAULTS,
  STYLES,
  rFonts,
  sz,
  color,
};
