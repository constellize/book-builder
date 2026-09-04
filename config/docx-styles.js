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
 * ---------------------------------------------------------------------------
 * LEADING — ABSOLUTE, IN TWENTIETHS OF A POINT, NOT MULTIPLES OF SINGLE
 * ---------------------------------------------------------------------------
 * These used to be `w:lineRule="auto"` multipliers (288 = 1.2 x single) on the
 * theory that `linestretch: 1.2` and `w:line="288"` say the same thing. They do
 * not, and the difference is visible on every page.
 *
 *   LaTeX   \setstretch{1.2} scales \baselineskip, and book-class 11pt sets
 *           \baselineskip to 13.55pt.          -> 13.55 x 1.2 = 16.26pt
 *   Word    w:lineRule="auto" scales the FONT'S OWN natural line height.
 *           Atkinson Hyperlegible Next hhea: ascent 796, descent -161,
 *           lineGap 200, upem 1000 -> 1.157em -> 12.73pt at 11pt.
 *                                              -> 12.73 x 1.2 = 15.27pt
 *
 * i.e. the same "1.2" applied to two different bases, 5.8% apart. Measured with
 * pdftotext -bbox over pp30-60 of both renders, modal consecutive-baseline
 * delta: LaTeX 16.26pt, Word 15.36pt. The fix is to stop expressing leading as
 * a ratio at all and pin the absolute value the LaTeX PDF actually produces.
 *
 * ON THE 13.55 ABOVE, because the obvious number is 13.60. The book class's
 * 11pt \baselineskip is usually quoted as 13.6pt, and 13.6 x 1.2 = 16.32 would
 * make 326 (16.30pt) an exact hit. The PDF says otherwise: over pp20-120 the
 * consecutive-baseline delta is 16.26pt on 100.0% of 402 samples, with no
 * second mode at all, and the unstretched leading measured independently off
 * the figure captions is 13.55pt -- and 13.55 x 1.2 = 16.26 exactly. So the
 * real target is 16.26pt = 325.2 twentieths, and the theoretical bullseye is
 * 325, not 326.
 *
 * 326 ships anyway, deliberately. Word does not render a single clean pitch: it
 * snaps baselines to a device grid, giving 16.32pt on 90.2% of lines and
 * 16.08pt on 9.4%, for a weighted mean of 16.303pt -- i.e. it delivers exactly
 * what 326 asks for, with +/-0.03pt of grid noise on any individual line. The
 * residual against LaTeX is 0.043pt per line (0.26%), which is an order of
 * magnitude below that noise, and 326 already reproduces the print PDF's page
 * count exactly (190 = 190). Moving to 325 would chase 0.04pt through a full
 * rebuild and risk that exact match for nothing visible.
 *
 * EVERY NUMBER BELOW IS MEASURED OFF build/print/constellize-book.pdf, not
 * computed. The measurement bucketed rendered lines by their left-edge offset
 * from the body margin (which is what distinguishes body / list / callout /
 * code geometrically) and took the modal baseline delta in each bucket:
 *
 *   offset  +0.0pt  body prose        16.26pt   <- body
 *   offset +15.6pt  callout text      16.26pt   <- body (callouts are BodyText)
 *   offset +17.0pt  list item L1      16.26pt   <- body
 *   offset +27.3pt  list item L2      16.26pt   <- body
 *   offset  +9.7pt  code              14.35pt   <- code
 *   wrapped chapter titles (\Huge)    35.86pt   <- h1  (n=6)
 *   wrapped section titles (\Large)   21.52pt   <- h2  (n=2)
 *   figure captions                   13.55pt   <- caption (n=51 wrapped)
 *   footnote text                     11.16pt   <- footnote
 *   TOC entries                       16.26-16.33pt -> body, but NOT inherited:
 *                                     TOC1-3 are built in docx-postprocess.js
 *                                     (tocStyleXml) and are basedOn BodyText yet
 *                                     OVERRIDE w:spacing, so they take LINE.body
 *                                     explicitly. Change both places together.
 *
 * h3 is the one value with no wrapped instance in the book to measure. It is
 * derived from the model the other two validate: LaTeX \large at 11pt base is
 * 12.1pt/14pt, and 14 x 1.2 = 16.8pt. That model predicts h1 as 30 x 1.2 = 36
 * (measured 35.86) and h2 as 18 x 1.2 = 21.6 (measured 21.52), so it is good
 * to better than half a point.
 *
 * ALWAYS PAIRED WITH w:lineRule="atLeast", never "exact" — see spacing().
 */
const LINE = {
  body: 326, // 16.30pt
  code: 287, // 14.35pt
  h1: 717, // 35.85pt
  h2: 430, // 21.50pt
  h3: 336, // 16.80pt
  caption: 271, // 13.55pt
  footnote: 224, // 11.20pt

  /**
   * The ONE remaining ratio, and the one place it is right: running heads.
   * 240 = single, w:lineRule="auto". A running head is a single 9pt line
   * inside a 0.5in header band; giving it body leading would inflate that band
   * and push it toward the 0.4pt head rule for no gain. See spacing().
   */
  tight: 240,
};

/**
 * ---------------------------------------------------------------------------
 * HYPHENATION
 * ---------------------------------------------------------------------------
 * Mandatory once the body is justified, not a nicety. Justified text without
 * hyphenation has to absorb every line's slack in the word spaces, which is
 * what produces rivers. LaTeX has been hyphenating all along; word/settings.xml
 * carried no hyphenation elements at all, so the docx was doing neither.
 *
 * Whole-book measurement of the LaTeX print PDF (1554 body lines):
 *   hyphenated lines           170  = 10.94%
 *   consecutive-hyphen runs    130 singles, 20 pairs, ZERO runs of 3+
 *   all-caps words hyphenated  1
 *
 * so `consecutiveLimit: 2` is not a guess — it is exactly the ceiling LaTeX's
 * \doublehyphendemerits already enforces here, and `doNotHyphenateCaps` costs
 * one hyphenation in the whole book while ruling out mangled acronyms (API,
 * SRE, CODEPROMPTU) for good.
 *
 * `zone` is the knob with no LaTeX counterpart: the widest ragged gap Word will
 * tolerate before it reaches for a hyphen, in twips. Too wide and it never
 * hyphenates and the rivers come back; too narrow and it hyphenates everything.
 *
 * TUNED, NOT ASSUMED. Seven full Word renders of the real book, each measured
 * over pp9-190 the same way as the LaTeX reference (hyphen-terminated share of
 * flush-left body lines, and the inter-word gap distribution on full-measure
 * justified lines only):
 *
 *   zone   inches   hyphenated   median gap   p95 gap
 *    288    0.200     18.08%        3.91pt     5.96pt
 *    432    0.300     16.42%           -          -
 *    576    0.400     12.48%        4.13pt     6.05pt
 *    600    0.417     11.55%        4.16pt     6.14pt
 *  > 624    0.433     10.75%        4.20pt     6.25pt   <- shipped
 *    648    0.450     10.07%        4.22pt     6.35pt
 *    720    0.500      8.53%        4.28pt     6.61pt
 *   LaTeX  reference  10.91%        3.35pt     4.64pt
 *
 * 624 is the value that reproduces LaTeX's own hyphenation rate: 175 hyphenated
 * lines against LaTeX's 170, out of ~1600. Its consecutive-run profile lands in
 * the same place too — 147 singles + 14 pairs vs LaTeX's 130 + 20.
 *
 * The sweep also settles a question the rate alone cannot. Word's word spaces
 * are looser than TeX's at EVERY zone (median 3.91-4.28pt vs 3.35pt) because
 * Word breaks lines greedily while TeX optimises the whole paragraph, and the
 * gap grows monotonically as the zone widens. So the error is not symmetric:
 * overshooting the zone costs word spacing on every justified line in the book,
 * while undershooting only costs some extra hyphens. That rules out the "round"
 * 0.5in, and is why the shipped value sits on the tight side of the bracket
 * rather than at 648 — which is marginally closer on rate but looser on colour.
 */
const HYPHENATION = {
  zone: 624, // 0.433in / 31.2pt
  consecutiveLimit: 2,
  doNotHyphenateCaps: true,
};

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
 * Build a `<w:spacing>`.
 *
 * WHY THE LINE RULE IS NOT A FREE PARAMETER. Every absolute value in LINE is a
 * leading in twentieths of a point, and an absolute leading is only meaningful
 * with `atLeast` or `exact`. Pair one with the inherited `auto` by accident and
 * Word reads it as a 13.6x multiplier — a silent, spectacular bug. So the rule
 * defaults to `atLeast` and the only way to get `auto` through THIS helper is to
 * ask for it by name, which exactly one caller (the running heads) does.
 *
 * Note this helper is not the only writer of w:spacing: tocStyleXml() in
 * scripts/lib/docx-postprocess.js emits its own for TOC1-3. It shipped a literal
 * 240/auto for one release, which is exactly the bug described above. If you add
 * another w:spacing writer, route it through here or it will drift the same way.
 *
 * `atLeast`, NEVER `exact`: atLeast is max(natural, requested), so a line
 * carrying an inline image, a superscript footnote mark or a larger glyph grows
 * to fit. `exact` would clip it. The cost of atLeast is that such a line is
 * taller than its neighbours; the cost of exact is that the content is gone.
 *
 * @param {object} opts
 * @param {number} [opts.before] space above, twips
 * @param {number} [opts.after] space below, twips
 * @param {number|null} [opts.line] leading, twentieths of a point; null to
 *   inherit the parent style's
 * @param {'atLeast'|'auto'|'exact'} [opts.rule]
 * @returns {string} XML
 */
const spacing = ({ before = 0, after = 0, line = null, rule = 'atLeast' }) =>
  `<w:spacing w:before="${before}" w:after="${after}"` +
  (line === null ? '' : ` w:line="${line}" w:lineRule="${rule}"`) +
  '/>';

/**
 * Build a `<w:jc>`.
 *
 * Justification is the second half of matching the LaTeX setting: there was no
 * `w:jc="both"` anywhere in word/styles.xml, so the whole book was ragged-right
 * against a justified PDF. Measured on the LaTeX print render as the spread of
 * right-edge x over lines that reach the measure — interquartile range, which
 * is immune to the tail of paragraph-final lines:
 *
 *   context        IQR      verdict
 *   body prose     1.16pt   justified
 *   callout text   1.62pt   justified (flush to the box's own right edge)
 *   captions       1.97pt   justified
 *   chapter/section titles   land exactly on the margin, and hyphenate
 *                                     -> justified (titlesec's default; there
 *                                        is no \raggedright in either template)
 *   list items     spike at 0pt       -> justified
 *   code          22.67pt   ragged
 *   table cells   ~100pt of variation -> ragged (pandoc's LaTeX writer emits
 *                                        >{\raggedright\arraybackslash}p{...})
 *
 * @param {'both'|'left'|'center'|'right'} v
 * @returns {string} XML
 */
const jc = (v) => `<w:jc w:val="${v}"/>`;

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
 * HEADINGS ARE JUSTIFIED, AND THAT IS NOT A GUESS. The brief for this change
 * assumed \raggedright, which is indeed what most heading packages do — but
 * neither book-digital.latex nor book-print.latex contains \raggedright,
 * \RaggedRight or a titlesec alignment key, and titlesec's default is
 * justified. The rendered PDF agrees: of six wrapped chapter titles, one
 * ("Scaling Knowledge and Constellations", p117) ends at x=540.0 against a
 * margin of exactly 540.0, and two others hyphenate ("...the Constel-" p41,
 * "...Site Relia-" p135). Ragged-right does neither. The remaining three
 * overrun the margin by 4.6-14.5pt, which is an overfull \hbox — again, a
 * justified-only phenomenon.
 *
 * `line` is per-level because heading leading tracks heading size: \Huge, \Large
 * and \large each carry their own \baselineskip and the 1.2 stretch multiplies
 * all three. See LINE for the measurements.
 *
 * @param {object} opts
 * @param {number} opts.before space before, twips
 * @param {number} opts.after space after, twips
 * @param {number} opts.line leading, twentieths of a point
 * @param {number} opts.level 0-based outline level
 * @param {boolean} [opts.pageBreak] start the heading on a new page
 * @returns {string} XML
 */
const headingPPr = ({ before, after, line, level, pageBreak = false }) =>
  '<w:pPr>' +
  '<w:keepNext/><w:keepLines/>' +
  (pageBreak ? '<w:pageBreakBefore/>' : '') +
  '<w:widowControl/>' +
  '<w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs>' +
  spacing({ before, after, line }) +
  '<w:ind w:firstLine="0"/>' +
  jc('both') +
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
// Table of contents
// ---------------------------------------------------------------------------

/**
 * The `toc 1` / `toc 2` / `toc 3` paragraph styles the Contents entries use.
 *
 * WHY THIS LIVES HERE AND IS APPLIED BY docx-postprocess.js, NOT BY THE
 * REFERENCE DOC
 * ---------------------------------------------------------------------------
 * Neither pandoc's baseline reference.docx nor either of ours defines these
 * (grep `w:styleId="TOC` in each templates/docx/src-VARIANT/word/styles.xml:
 * only TOCHeading). They are deliberately NOT in STYLES below, because `create`
 * branch of build-reference-docx.js stamps every style it invents with
 * `w:customStyle="1"`, and these three are *built-in* Word styles. A built-in
 * name carrying customStyle="1" is the one shape Word can decide to duplicate
 * rather than adopt when a reader presses F9 on the field. docx-postprocess.js
 * injects them into the built .docx instead, as proper built-ins.
 *
 * THEY ARE LOAD-BEARING FOR THE PAGE NUMBERS, NOT JUST FOR LOOKS. The entry
 * paragraphs' indents and spacing set how many lines the Contents occupies,
 * which sets where the body starts, which sets every page number in the
 * Contents. Measured: with no TOC styles at all Word falls back to its gallery
 * defaults (after=100, ind 220/440), the Contents runs two pages longer and
 * Foreword lands on p9 instead of p7. Change these values and the page numbers
 * move; that is expected and is why they are recomputed on every build.
 *
 * `basedOn BodyText` inherits the book's face and 1.2 line, so `firstLine=0` is
 * mandatory — BodyText carries a 340tw first-line indent (PARINDENT) and
 * without the reset every entry's first (only) line would be indented by it.
 *
 * `numberTab` is where the heading's section number ("1", "1.3", "1.3.1") ends
 * and the title begins. These are the values Word itself picks for this
 * document (measured off a Word-regenerated TOC: 480 at level 1, 1200 at level
 * 3), expressed as the rule that produces them.
 */
const TOC = {
  /** Right tab stop the dot leader runs to, twips. Word's own choice here. */
  leaderTabPos: 9062,

  /**
   * One entry per outline level, index 0 = `toc 1`.
   *
   * Level 1 is bold and carries 6pt above it so a chapter line separates the
   * block of sections before it from the block after; `before` and `after` add
   * rather than collapse in Word, so that is 6pt on top of the previous entry's
   * 3pt. Levels 2 and 3 step in by 12pt each.
   */
  levels: [
    { indent: 0, before: 120, after: 60, bold: true },
    { indent: 240, before: 0, after: 60, bold: false },
    { indent: 480, before: 0, after: 60, bold: false },
  ],

  /**
   * Left tab stop separating a section number from its title, twips, relative
   * to the level's own indent. Level 1 numbers are one digit ("9"); levels 2
   * and 3 are "9.9" and "9.9.9" and need the wider stop.
   */
  numberTab: (level) => (level === 1 ? 480 : 720),

  /**
   * The field instruction. Must stay in step with what pandoc's `--toc` writes,
   * because docx-postprocess.js reuses whatever it finds and only falls back to
   * this. `\o "1-3"` = outline levels 1-3, `\h` = hyperlinked entries, `\z` =
   * hide page numbers in web layout, `\u` = use applied paragraph outline level.
   */
  instruction: 'TOC \\o "1-3" \\h \\z \\u',

  /**
   * `\n` suppresses page numbers entirely. This is the no-Word fallback: a
   * complete, clickable Contents with no numbers, rather than a Contents whose
   * dot leaders run to a blank. See docx-postprocess.js buildTocField().
   */
  instructionNoPages: 'TOC \\o "1-3" \\h \\z \\u \\n',
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
 *
 * docx-postprocess.js now defines TOC1-3 explicitly (see TOC above), so the
 * entries no longer *depend* on the theme. This stays anyway: it is still the
 * only thing standing behind any style Word materialises from its gallery, and
 * a reader who rebuilds the field with F9 gets the book's face either way.
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
  /**
   * NO w:jc HERE, deliberately. Justification is set on BodyText and inherited
   * by the prose styles that should have it. Putting it in docDefaults would
   * hand it to every style in the document at once — including the ones the
   * measurements say must stay ragged (SourceCode, Compact's table cells) and
   * the ones where it is meaningless but risky (Header/Footer, TOC entries with
   * dot leaders). Defaults are the wrong altitude for a decision this selective.
   */
  pPr:
    '<w:widowControl/>' +
    spacing({ after: 0, line: LINE.body }),
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
      headingPPr({ before: 0, after: 400, line: LINE.h1, level: 0, pageBreak: true }) +
      `<w:rPr>${TITLING_RPR.Heading1}</w:rPr>`,
  },

  Heading2: {
    replace: true,
    body:
      '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/>' +
      '<w:link w:val="Heading2Char"/><w:uiPriority w:val="9"/><w:qFormat/>' +
      headingPPr({ before: 360, after: 120, line: LINE.h2, level: 1 }) +
      `<w:rPr>${TITLING_RPR.Heading2}</w:rPr>`,
  },

  Heading3: {
    replace: true,
    body:
      '<w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/>' +
      '<w:link w:val="Heading3Char"/><w:uiPriority w:val="9"/><w:qFormat/>' +
      headingPPr({ before: 280, after: 100, line: LINE.h3, level: 2 }) +
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
      spacing({ before: 0, after: 0, line: LINE.body }) +
      `<w:ind w:firstLine="${PARINDENT}"/>` +
      // Reaches further than "body prose". BodyText is also the paragraph
      // style pandoc puts inside the callout tables (measured: 300 BodyText
      // paragraphs across the 186 single-column tables), and the LaTeX
      // callouts are justified too — their text is flush to the box's own
      // right edge at 510.0pt, IQR 1.62pt. So one w:jc here is correct for
      // both, and BlockText / FirstParagraph / Bibliography inherit it.
      jc('both') +
      '</w:pPr>',
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

  /**
   * Compact is used for list items and table cells. It MUST zero the inherited
   * first-line indent or every bullet gets an extra 17pt of hanging text.
   *
   * LEADING: promoted from LINE.tight to full body leading. LaTeX's `itemize`
   * does not touch \baselineskip — only \itemsep and \parsep — so list items
   * are set on the same 16.30pt body leading as everything else. Measured in
   * the print PDF at the left-edge offsets lists actually occupy: +17.0pt
   * (level 1), +27.3pt (level 2) and +24.4pt all read a modal 16.26pt, the
   * same as body prose. The old 240/auto was 12.73pt, tighter than body text
   * in a book whose lists carry a lot of its argument.
   *
   * JUSTIFICATION: left, and this is the ONE place the docx knowingly departs
   * from the LaTeX PDF. pandoc gives list items and table cells the SAME style
   * name, and OOXML paragraph styles have no "when inside a table" selector,
   * so one w:jc has to serve both. They want opposite things:
   *
   *   list items   LaTeX justifies them (right-edge histogram spikes at 0pt,
   *                45 of 197 measured lines flush to the margin) -> wants both
   *   table cells  LaTeX raggeds them — pandoc's own LaTeX writer emits
   *                >{\raggedright\arraybackslash}p{...} for wrapped columns,
   *                and the render confirms it: the two 3-column tables on
   *                pp138-139 have cell right edges scattered over ~100pt
   *                                                            -> wants left
   *
   * Left wins because the two failure modes are not symmetric. A ragged list
   * item is ordinary book typography that nobody will look at twice. A
   * justified table cell in a ~190pt column is ~30 characters wide, which is
   * far too narrow to absorb justification: the word spaces blow open and the
   * cell fills with rivers. Counted in the built document.xml, 265 Compact
   * paragraphs are list items and 51 are cells in those two tables — so this
   * trades a small, invisible loss on the many for avoiding a large, glaring
   * one on the few, and it is the choice pandoc's LaTeX writer already made.
   *
   * To revisit: the fix is not here but upstream — have the post-process give
   * table-cell paragraphs their own style (or direct w:jc), then set both to
   * `both` here. That file is outside this change's remit.
   */
  Compact: {
    replace: true,
    body:
      '<w:name w:val="Compact"/><w:basedOn w:val="BodyText"/><w:qFormat/>' +
      '<w:pPr>' +
      spacing({ before: 36, after: 36, line: LINE.body }) +
      '<w:ind w:firstLine="0"/>' +
      jc('left') +
      '</w:pPr>',
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
      // 11.20pt. basedOn Normal, so without an explicit line this would inherit
      // docDefaults' 16.30pt body leading — half again too loose for 9pt notes.
      // Measured off the print PDF's footnote block (9pt glyphs, y>620): 11.16pt,
      // i.e. \footnotesize's 11pt \baselineskip. The book's footnotes are 26
      // lines of mostly single-line URLs, so this is a small effect either way.
      spacing({ before: 0, after: 40, line: LINE.footnote }) +
      '<w:ind w:firstLine="0"/></w:pPr>' +
      `<w:rPr>${sz(SIZE.footnote)}</w:rPr>`,
  },

  /**
   * Caption is basedOn Normal, so it too would otherwise inherit the 16.30pt
   * body leading. Measured: figure captions run at 13.55pt (51 of the book's 58
   * captions wrap, so this is well sampled) — the book class's natural 11pt
   * \baselineskip, WITHOUT the 1.2 stretch, which is what setspace does to
   * \caption.
   *
   * The centring is left alone deliberately. pandoc's baseline Caption carries
   * no w:jc at all, so the `center` here is this project's own decision, not an
   * inherited default. Worth recording that it does NOT match the PDF: LaTeX
   * sets a caption that wraps as an ordinary justified paragraph (IQR 1.97pt,
   * 94.1% of full-measure caption lines flush to the margin) and only centres
   * the ones short enough to fit on a single line — behaviour w:jc cannot
   * express, since Word has no "centre if it fits, else justify". Changing this
   * is a live design choice, not a defect fix, so it stays as the project set it.
   */
  Caption: {
    patchPPr:
      spacing({ before: 0, after: 120, line: LINE.caption }) +
      '<w:ind w:firstLine="0"/>' +
      jc('center'),
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
      // 14.35pt, measured off the code blocks in the print PDF (left-edge
      // offset +9.7pt; the 28.44/28.69pt deltas in that bucket are blank lines,
      // i.e. exactly 2x). Code must NOT take the 16.30pt body leading: it is
      // 9pt type, and body leading on it would open the blocks up by 14% and
      // break the visual density that makes a listing read as a listing.
      // Equally it must not be left on the old 240/auto (10.41pt), which is
      // tighter than LaTeX. This is the one style with its own measured value.
      spacing({ before: 120, after: 120, line: LINE.code }) +
      '<w:ind w:left="240" w:right="240" w:firstLine="0"/>' +
      // Explicit, not merely inherited. SourceCode is basedOn Normal so it does
      // not pick up BodyText's w:jc today — but a future docDefaults change
      // could hand it one, and justified code means shifted columns and broken
      // ASCII alignment. Measured in the PDF at 22.67pt IQR: LaTeX ragges it.
      jc('left') +
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
  //
  // These two keep LINE.tight / w:lineRule="auto" — the only styles that do,
  // and the only ones where a ratio is still the right expression. A running
  // head is one 9pt line inside a 0.5in header band; there is no body text to
  // stay in register with, and 16.30pt of leading would just push the line
  // toward the 0.4pt head rule. Alignment is set per-cell by the header table,
  // not here, so no w:jc either.
  Header: {
    create: true,
    type: 'paragraph',
    body:
      '<w:name w:val="header"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/>' +
      '<w:pPr>' +
      spacing({ before: 0, after: 0, line: LINE.tight, rule: 'auto' }) +
      '<w:ind w:firstLine="0"/></w:pPr>' +
      `<w:rPr>${sz(SIZE.headerFooter)}</w:rPr>`,
  },
  Footer: {
    create: true,
    type: 'paragraph',
    body:
      '<w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/>' +
      '<w:pPr>' +
      spacing({ before: 0, after: 0, line: LINE.tight, rule: 'auto' }) +
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
 * The `plain` page style's footer: a centred folio, nothing else.
 *
 * fancyhdr's `plain` is NOT an empty page style. `\fancypagestyle{plain}` is
 * left at its LaTeX default, which is an empty head plus `\@oddfoot =
 * {\hfil\thepage\hfil}` — and `\chapter` issues `\thispagestyle{plain}` on every
 * chapter opening. Measured on the shipped print PDF, page 9 (the Foreword
 * opening): a centred "9" at x 309.95..316.44pt, i.e. centred on 313.20pt.
 *
 * That is the TEXT BLOCK centre on a recto, not the paper centre (306.00pt):
 * `\hfil…\hfil` centres within `\textwidth`, which `bindingoffset=0.2in` has
 * already shifted 14.4pt outward. `w:jc="center"` in a footer part centres
 * between the section's left and right margins, which mirrorMargins shifts the
 * same way — so this reproduces the LaTeX position rather than approximating it.
 * Do NOT "fix" this to the paper centre.
 */
const PLAIN_FOOTER = { align: 'center', field: { kind: 'page' }, placeholder: '1' };

/**
 * Header and footer parts. BOTH variants, because both LaTeX templates set
 * `classoption: [twoside, openright]` and the same \fancyhead block: a recto
 * layout, a mirrored verso layout, and a `first` pair reproducing
 * \thispagestyle{plain} — blank head, centred folio.
 *
 * The `first` parts are what make titlePg meaningful. Each chapter section
 * carries titlePg, so a chapter's opening page draws these instead of a running
 * head. Both halves are load-bearing and they are NOT symmetric:
 *
 *   header3 (blank)  = `plain` has no running head        -> \fancyhead{} cleared
 *   footer3 (folio)  = `plain` DOES have a centred folio   -> \@oddfoot{\hfil\thepage\hfil}
 *
 * Declaring only the blank header — as this config did until the folio was
 * restored — leaves a chapter opening with neither a head nor a page number,
 * because `w:titlePg` suppresses the `default`/`even` footer on that page too.
 * Measured, same engine, same six-chapter document, footerReference w:type="first"
 * stripped vs present: 7 opening pages with an empty footer band vs 7 carrying a
 * folio. One folio-less page per section, for every section in the book.
 */
const HEADERS = [
  { type: 'default', file: 'header1.xml', cells: RECTO_HEADER },
  { type: 'even', file: 'header2.xml', cells: VERSO_HEADER },
  { type: 'first', file: 'header3.xml', cells: null },
];
const FOOTERS = [
  { type: 'default', file: 'footer1.xml', cells: null },
  { type: 'even', file: 'footer2.xml', cells: null },
  { type: 'first', file: 'footer3.xml', paragraph: PLAIN_FOOTER },
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
  toc: TOC,
  hyphenation: HYPHENATION,

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
     * ---- hyphenation ----------------------------------------------------
     * CT_Settings is an ordered sequence and Word silently DROPS a child that
     * arrives out of order — no error, no warning, the setting simply does not
     * exist. The schema order through this region is:
     *
     *   ... defaultTabStop
     *       autoHyphenation
     *       consecutiveHyphenLimit
     *       hyphenationZone
     *       doNotHyphenateCaps
     *       ... showEnvelope, summaryLength, clickAndTypeStyle,
     *           defaultTableStyle ...
     *       evenAndOddHeaders
     *       ... bookFold* ...
     *       drawingGridHorizontalSpacing ...
     *
     * so each of the four anchors off the one before it, and the first anchors
     * off defaultTabStop (present in pandoc's baseline). Chaining rather than
     * anchoring all four to defaultTabStop is what keeps them in order: these
     * rules are applied in array order and each inserts IMMEDIATELY after its
     * anchor, so four rules sharing one anchor would come out reversed.
     *
     * This is the same class of bug as the known-latent one in
     * scripts/lib/font-embed.js injectSettingsFlags, which places
     * embedTrueTypeFonts AFTER embedSystemFonts when the schema wants it
     * before. That function is unused; it is not adopted here and its mistake
     * is not repeated.
     */
    { xml: '<w:autoHyphenation w:val="true"/>', after: 'w:defaultTabStop' },
    {
      xml: `<w:consecutiveHyphenLimit w:val="${HYPHENATION.consecutiveLimit}"/>`,
      after: 'w:autoHyphenation',
    },
    {
      xml: `<w:hyphenationZone w:val="${HYPHENATION.zone}"/>`,
      after: 'w:consecutiveHyphenLimit',
    },
    ...(HYPHENATION.doNotHyphenateCaps
      ? [
          {
            xml: '<w:doNotHyphenateCaps w:val="true"/>',
            after: 'w:hyphenationZone',
          },
        ]
      : []),
    /*
     * `<w:updateFields w:val="true"/>` USED TO BE HERE. IT IS DELIBERATELY GONE.
     *
     * It was the standards-correct request to refresh fields (TOC page numbers)
     * on open, kept on the theory that it was the documented signal and cost
     * nothing. Both halves of that turned out to be false, measured against Word
     * 16.112 and LibreOffice 26.8:
     *
     *   - It never worked. Whether the TOC populates is driven by the presence
     *     of TOC/STYLEREF/PAGE fields plus the user's "update automatic links at
     *     open" preference, not by this flag. Clicking No left the TOC empty
     *     WITH the flag set; clicking Yes populated it WITHOUT it. LibreOffice's
     *     headless conversion ignores it outright.
     *   - It is not free. On a document that already carries a correct cached
     *     TOC — which every build now produces, see docx-postprocess.js — the
     *     flag asks Word to throw that cache away and recompute, which means the
     *     "update links" modal. A/B on the same open-and-count operation: the
     *     old file with the preference ON blocked on the modal and died after
     *     71.3s; the new file with the preference ON opened in 1.65s.
     *
     * So the flag now costs a dialog and buys nothing. Removing it, clearing
     * `w:dirty` off the field, and shipping a real cached result are one change,
     * and all three are applied by docx-postprocess.js (which also strips this
     * element from the reference doc's settings.xml, so a stale reference-docx
     * binary cannot reintroduce it).
     */
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
        ? // Anchored BEFORE drawingGridHorizontalSpacing, not after
          // defaultTabStop as it used to be. The hyphenation block now sits
          // between those two, and "after defaultTabStop" would have inserted
          // this ahead of it — putting evenAndOddHeaders before
          // autoHyphenation, which is backwards in CT_Settings and would have
          // cost the hyphenation silently. drawingGridHorizontalSpacing is in
          // pandoc's baseline and is the next element after this one that is.
          { xml: '<w:evenAndOddHeaders/>', before: 'w:drawingGridHorizontalSpacing' }
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
  HYPHENATION,
  LIST_MARKERS,
  TOC,
  THEME,
  DOC_DEFAULTS,
  STYLES,
  rFonts,
  sz,
  color,
  spacing,
  jc,
};
