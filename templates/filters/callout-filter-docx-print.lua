--[[
Callout Filter for Constellize Book -- DOCX output, PRINT variant

Twin of callout-filter-docx-digital.lua. The two files are a near-identical
pair: they share a PRIMITIVES region and a BODY region that are byte-identical,
and differ only in the VARIANT region in the middle, which draws the box chrome.
That is the same relationship callout-filter-digital.lua and
callout-filter-print.lua have around their SHARED HTML/EPUB BLOCK.

This variant mirrors the print tcolorbox in templates/book-print.latex: a fully
framed box in `colframe=<accent>!75!black` with a solid accent title band across
the top (`boxed title style={colback=<accent>!75!black}`) and a `!5!white` body
tint.

Usage:
  pandoc ... -t docx --lua-filter=callout-filter-docx-print.lua
  pandoc ... -t docx --lua-filter=callout-filter-docx-print.lua \
             -M docx-callout-width=9072

Nothing here depends on styles in the reference document: the geometry is all
emitted inline, so the boxes survive a reference.docx that knows nothing about
callouts.
]]--

-- ============================================================================
-- BEGIN SHARED DOCX PRIMITIVES
-- ----------------------------------------------------------------------------
-- This region is byte-identical in callout-filter-docx-digital.lua and
-- callout-filter-docx-print.lua, exactly like the SHARED HTML/EPUB BLOCK in the
-- LaTeX pair. The two docx filters are meant to differ ONLY inside the VARIANT
-- region below; if you edit anything between the BEGIN/END markers, copy the
-- whole region into the sibling file so the two cannot drift.
--
-- Nothing in here carries a geometry NUMBER. Every twip value lives in the
-- VARIANT region, because the digital box (2 columns, no border) and the print
-- box (1 column, 1pt frame) need different numbers to land in the same place on
-- the page. The primitives are the shapes; the variant supplies the dimensions.
--
-- WHY RAW OPENXML AND NOT `custom-style` DIVS
-- -------------------------------------------
-- pandoc's docx writer maps `custom-style` on a Div to a PARAGRAPH style, and a
-- paragraph style does not reach block children: a fenced code block inside the
-- div still emits `SourceCode` and a list item still emits `Compact`, so those
-- blocks escape the callout entirely. 31 of the book's 156 callouts contain a
-- fenced code block, so a paragraph-style approach shatters on nearly a fifth of
-- them.
--
-- Instead we exploit the fact that the docx writer passes RawBlock "openxml"
-- through VERBATIM without parsing or validating it. That lets us emit an
-- UNBALANCED opening fragment (`<w:tbl>` ... `<w:tc><w:tcPr>...`), hand the div's
-- real content blocks back to pandoc so they render natively INSIDE the cell
-- (full fidelity: syntax highlighting, hyperlinks, images, nested tables), then
-- emit the matching closing fragment. Verified on pandoc 3.8.3.
--
-- THREE THINGS THAT FAIL SILENTLY IF YOU GET THEM WRONG
-- ----------------------------------------------------
-- 1. OOXML child order is a strict schema SEQUENCE, not a set. Word ignores
--    out-of-order children without any error:
--      CT_TblPrBase : tblW, tblJc, tblCellSpacing, tblInd, tblBorders, shd,
--                     tblLayout, tblCellMar, tblLook
--      CT_TcPrBase  : tcW, gridSpan, tcBorders, shd, noWrap, tcMar, vAlign
--    This is what made `tblLayout` look like a no-op during development.
-- 2. Word MERGES two `<w:tbl>` elements that are adjacent in the body into one
--    table, reconciling their grids and RESCALING BOTH (measured: a 453.60pt box
--    fused to a neighbour came out 448.08pt with its accent bar squeezed from
--    4.08 to 3.84pt). Every box therefore has to be fenced off by a paragraph;
--    see the spacer discussion below and the Blocks pass at the bottom.
-- 3. `<w:tblLayout w:type="fixed"/>` TOGETHER WITH `<w:tblW>` is required for a
--    full-width box; with autofit the box hugs its content. (Earlier reports of
--    "boxes shrink to content" despite fixed layout were macOS Quick Look
--    artifacts -- real Word and real LibreOffice both honour it.)
--
-- A table cell must also END with a `<w:p>`; a cell whose last child is a
-- `<w:tbl>` is invalid and Word repairs (i.e. silently rewrites) the document.
--
-- HOW WORD ACTUALLY POSITIONS A TABLE  (probe-measured in real Word, not guessed)
-- ------------------------------------------------------------------------------
--   textLeft = margin + tblInd                            <- ALWAYS, exactly
--   inkLeft  = margin + tblInd - max(M, bw/2) - bw/2      <- M = effective LEFT
--                                                            cell margin of the
--                                                            FIRST cell
--   inkRight = inkLeft + tblW + bw
--
-- `w:tblInd` indents the table's TEXT, not its border. The border is then pushed
-- back out to the left by the first cell's margin. That is the whole of defect 2:
-- with `tblInd=0` the text sits on the margin and the frame hangs 8.9pt into it.
--
-- Two invariants follow, and they are what keep a box's frame flush with the
-- text block for ANY inner inset you choose:
--
--   tblInd - tcMarLeft(first cell) = bw/2     pins the LEFT ink on the margin
--   tblW                           = WIDTH - bw   puts the RIGHT ink on the margin
--
-- where bw is the RENDERED border width in twips (`w:sz="8"` renders 0.96pt = 19
-- twips, not the nominal 1pt/20). Change `w:sz` and both constants move with it,
-- so re-probe rather than reasoning about it. A borderless variant has bw = 0,
-- which is why the digital box needs neither correction.
--
-- Only the FIRST cell's left margin displaces the table; in a multi-column box
-- the second cell's margin just positions its own text.
--
-- A NESTED table -- which is what every conversation turn is -- obeys a DIFFERENT
-- law, and assuming otherwise puts the turns 8.8pt too far right (measured):
--
--   inkLeft  = containing cell's TEXT origin + tblInd     <- ink, not text
--   textLeft = inkLeft + bw/2 + tcMarLeft
--
-- Word will not let a nested table's border hang back into its parent cell's
-- padding, so the margin insets the content instead of displacing the frame.
-- The practical consequence is the opposite of the body-level case: a turn wants
-- `tblInd=0` and carries its whole inset in `tcMar`, with no correction at all.
--
-- VERTICAL SPACE IS A PARAGRAPH, NOT A CELL MARGIN
-- ------------------------------------------------
-- `w:tcMar` top/bottom pads the INSIDE of a box only -- probed at 300 twips it
-- moved the inter-box gap not at all. The gap between a box and whatever is next
-- to it is entirely the height of the spacer paragraph between them, and
-- `w:before`, an exact `w:line` and `w:after` ADD rather than collapsing (two
-- adjacent 240tw spacers measured 25.92pt, not 12). So the spacer carries its
-- height in one place -- an exact `w:line` -- and the Blocks pass below collapses
-- runs of them, or a box sandwiched between two others would get double the gap.
-- ============================================================================

--[[ Usable text width in twips.

     Read off the reference documents' section properties, which both variants
     share (templates/docx/src-{digital,print}/word/document.xml):

         <w:pgSz  w:w="12240" w:h="15840"/>                 US Letter
         <w:pgMar w:left="1440" w:right="1440" ... w:gutter="288"/>

     12240 - 1440 - 1440 - 288 = 9072.

     The 288-twip (0.2in) binding gutter is the reason this is not the familiar
     9360: a box drawn at 9360 overflows the text block by 0.2in on every single
     callout. Matches the LaTeX side exactly -- `geometry{letterpaper, margin=1in,
     bindingoffset=0.2in}` gives \textwidth 453.6pt, and the print PDF measures
     453.606. Overridable with `-M docx-callout-width=<twips>` if the page
     geometry in config/docx-styles.js ever changes. ]]
local DEFAULT_WIDTH = 9072
local WIDTH = DEFAULT_WIDTH

--[[ The shortest spacer that still does its job, in twips.

     Used where a paragraph is structurally required but must not be seen: to
     terminate a cell whose last real block is a table, and to keep two tables
     from fusing when the space between them is already provided by something
     else. 20tw = 1pt, which is one Word layout grid unit (1/300in = 0.24pt)
     rounded up to something safely non-zero. ]]
local HAIRLINE = 20

-- Same titles and palette as callout-filter-{digital,print}.lua; `color` is the
-- `htmlcolor` field of those tables without the leading '#', because OOXML wants
-- a bare six-digit hex.
local callouts = {
  info         = { title = "Info",             color = "0066cc" },
  code         = { title = "Code",             color = "6f42c1" },
  success      = { title = "Success",          color = "28a745" },
  warning      = { title = "Warning",          color = "ffc107" },
  error        = { title = "Error",            color = "dc3545" },
  conversation = { title = "Conversation",     color = "20c997" },
  promptref    = { title = "Prompt Reference", color = "17a2b8" },
}

--[[ Conversation speaker turns.

     The LaTeX filters build these out of nested tcolorboxes with blue!10,
     green!10 and orange!10 fills; the web and epub CSS uses #e7f0fb, #e8f6ec and
     #fdf1e3. These accents at 10% land within a couple of levels of the CSS
     values (E7EFFF / E8F3EE / FFF2E7), so all four outputs read as the same
     book. ]]
local speakers = {
  Human      = { color = "0d6efd", italic = false },
  AI         = { color = "198754", italic = false },
  Reflection = { color = "fd7e14", italic = true  },
}
local speaker_order = { "Human", "AI", "Reflection" }

------------------------------------------------------------------ colour ----

local function split_rgb(hex)
  return tonumber(hex:sub(1, 2), 16), tonumber(hex:sub(3, 4), 16), tonumber(hex:sub(5, 6), 16)
end

--- LaTeX `color!pct!white` -- lighten toward white.
local function tint(hex, pct)
  local r, g, b = split_rgb(hex)
  local f = pct / 100
  return string.format("%02X%02X%02X",
    math.floor(r * f + 255 * (1 - f) + 0.5),
    math.floor(g * f + 255 * (1 - f) + 0.5),
    math.floor(b * f + 255 * (1 - f) + 0.5))
end

--- LaTeX `color!pct!black` -- darken toward black.
local function shade(hex, pct)
  local r, g, b = split_rgb(hex)
  local f = pct / 100
  return string.format("%02X%02X%02X",
    math.floor(r * f + 0.5), math.floor(g * f + 0.5), math.floor(b * f + 0.5))
end

--- Titles come from author-written `title="..."` attributes, so they can and do
--- contain `&`. Raw OpenXML is not escaped by pandoc, so we must escape here.
local function xml_escape(s)
  return (s:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;"))
end

-------------------------------------------------------------- xml pieces ----

local function raw(s)
  return pandoc.RawBlock("openxml", s)
end

--- All-`none` border set. `inside` also covers insideH/insideV (table level).
local function no_borders(inside)
  local sides = inside
    and { "top", "left", "bottom", "right", "insideH", "insideV" }
    or { "top", "left", "bottom", "right" }
  local t = {}
  for _, s in ipairs(sides) do
    t[#t + 1] = string.format('<w:%s w:val="none" w:sz="0" w:space="0" w:color="auto"/>', s)
  end
  return table.concat(t)
end

--- Complete `<w:tcBorders>` frame. `sz` is in EIGHTHS of a point (8 = 1pt).
local function frame_borders(color, sz)
  local t = {}
  for _, s in ipairs({ "top", "left", "bottom", "right" }) do
    t[#t + 1] = string.format('<w:%s w:val="single" w:sz="%d" w:space="0" w:color="%s"/>', s, sz, color)
  end
  return "<w:tcBorders>" .. table.concat(t) .. "</w:tcBorders>"
end

local function tc_mar(top, left, bottom, right)
  return string.format(
    '<w:tcMar><w:top w:w="%d" w:type="dxa"/><w:left w:w="%d" w:type="dxa"/>' ..
    '<w:bottom w:w="%d" w:type="dxa"/><w:right w:w="%d" w:type="dxa"/></w:tcMar>',
    top, left, bottom, right)
end

--- `<w:tbl><w:tblPr>...<w:tblGrid>` opener. `cols` is a list of twip widths and
--- `ind` is the `w:tblInd` that positions the first cell's TEXT (see the
--- positioning law in the header -- it is not the position of the border).
--- See note 1 above: this child order is load-bearing.
local function tbl_open(cols, ind)
  local total, grid = 0, {}
  for _, w in ipairs(cols) do
    total = total + w
    grid[#grid + 1] = string.format('<w:gridCol w:w="%d"/>', w)
  end
  return table.concat({
    '<w:tbl><w:tblPr>',
      string.format('<w:tblW w:w="%d" w:type="dxa"/>', total),
      string.format('<w:tblInd w:w="%d" w:type="dxa"/>', ind),
      '<w:tblBorders>', no_borders(true), '</w:tblBorders>',
      '<w:tblLayout w:type="fixed"/>',
      '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' ..
        '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>',
      '<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0"' ..
        ' w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>',
    '</w:tblPr>',
    '<w:tblGrid>', table.concat(grid), '</w:tblGrid>',
  })
end

--- `<w:tc><w:tcPr>...</w:tcPr>` opener, left deliberately unclosed. `mar` is
--- required: a cell's left margin is half of what positions the box (see the
--- law in the header), so there is no sane default for it to fall back on.
--- See note 1 above: this child order is load-bearing.
local function tc_open(w, fill, mar, borders)
  return table.concat({
    '<w:tc><w:tcPr>',
      string.format('<w:tcW w:w="%d" w:type="dxa"/>', w),
      borders or ('<w:tcBorders>' .. no_borders(false) .. '</w:tcBorders>'),
      string.format('<w:shd w:val="clear" w:color="auto" w:fill="%s"/>', fill),
      mar,
    '</w:tcPr>',
  })
end

--[[ An empty paragraph exactly `line` twips tall.

     This is the only thing that puts vertical space around a box, and it is also
     what stops Word fusing two adjacent `<w:tbl>` into one (see note 2). Both
     jobs are done by the same element on purpose: an anti-fusion fence that is
     invisible was the old bug, and a visible gap that lets the boxes fuse would
     be a worse one.

     `w:lineRule="exact"` makes the height literal -- no font ascent or descent is
     added -- and the 1pt (`w:sz="2"`) paragraph mark is small enough to fit in
     any height we use. The height goes in `w:line` alone, never split with
     `w:before`/`w:after`, because those ADD; keeping it in one attribute is what
     makes the Blocks collapse pass below a simple max(). ]]
local function spacer_xml(line)
  return string.format(
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="%d" w:lineRule="exact"/>' ..
    '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>', line)
end

local function spacer(line)
  return raw(spacer_xml(line))
end

--- Recognise a spacer we emitted, and report its height in twips.
--- Ours are the only openxml RawBlocks in the document that consist of a bare
--- `<w:p>` carrying nothing but a `<w:pPr>`, so this cannot collide with the
--- box fragments (which open with `<w:tbl>` or close with `</w:tbl>`).
local function spacer_twips(b)
  if b.t ~= "RawBlock" or b.format ~= "openxml" then return nil end
  if not b.text:find('^<w:p><w:pPr><w:spacing ') then return nil end
  if not b.text:find('</w:pPr></w:p>$') then return nil end
  return tonumber(b.text:match('w:line="(%d+)" w:lineRule="exact"'))
end

--- Solid accent-coloured bar cell: a narrow extra table COLUMN rather than a
--- left border, because `w:shd` is honoured by every renderer tested while a
--- one-sided `w:tcBorders` is not. Zero margins on every side, which also makes
--- this the FIRST cell that leaves the table's ink on the margin (see the law).
local function bar_cell_xml(fill, width)
  return table.concat({
    tc_open(width, fill, tc_mar(0, 0, 0, 0)),
    spacer_xml(HAIRLINE),
    '</w:tc>',
  })
end

--- A complete title paragraph, as raw OOXML. 10pt bold, matching the LaTeX
--- `fonttitle=\small`. The typeface comes from the reference doc's docDefaults
--- (Atkinson Hyperlegible), so it is deliberately NOT specified here.
local function title_xml(text, color, before, after)
  return table.concat({
    '<w:p><w:pPr><w:keepNext/>',
      string.format('<w:spacing w:before="%d" w:after="%d"/>', before, after),
    '</w:pPr>',
    '<w:r><w:rPr><w:b/><w:bCs/>',
      string.format('<w:color w:val="%s"/>', color),
      '<w:sz w:val="20"/><w:szCs w:val="20"/>',
    '</w:rPr>',
    string.format('<w:t xml:space="preserve">%s</w:t>', xml_escape(text)),
    '</w:r></w:p>',
  })
end

-- ============================================================================
-- END SHARED DOCX PRIMITIVES
-- ============================================================================

-- ============================================================================
-- VARIANT: print
-- ----------------------------------------------------------------------------
-- THE ONLY REGION THAT DIFFERS FROM callout-filter-docx-digital.lua.
--
-- Mirrors the print tcolorbox (templates/book-print.latex):
--   colback=<accent>!5!white, colframe=<accent>!75!black, and a boxed title
--   attached to the top of the frame in colback=<accent>!75!black.
--
-- Realised as a one-column, two-row table: a solid accent title band across the
-- full width, then the tinted body. Both rows carry the same hairline frame, so
-- the pair reads as one fully bordered box. `w:sz` is in eighths of a point, so
-- 8 = 1pt, close to tcolorbox's default 0.5mm boxrule.
--
-- GEOMETRY, AND WHERE EVERY NUMBER COMES FROM
-- -------------------------------------------
-- The target is the print PDF, measured with PyMuPDF over all 190 pages of
-- build/print/constellize-book.pdf:
--
--   box left edge vs body text left    +0.000 on all 190 callouts (n=190, sd=0)
--   inner text inset                   15.591pt  (n=568 lines -- dominant mode)
--   inner text inset, CODE callouts     9.707pt  (n=333; `left=0.5em` in
--                                                 callout-filter-print.lua, the
--                                                 one type that differs there)
--   title chip inset                    5.669pt  (n=137)
--   frame rule                          1.417pt  (0.5mm, tcolorbox default)
--
-- THIS is the variant that had defect 2. It has a real border, so bw != 0 and
-- both invariants from the primitives header bite:
--
--   tblInd - tcMarLeft = bw/2 = 10tw     pins the left ink on the margin
--   tblW               = 9072 - 19 = 9053   puts the right ink on the margin
--
-- With the old `tblInd=0, tcMar=170` the law gave inkLeft = margin - 8.98pt and
-- textLeft = margin + 0: the frame hung 8.9pt out into the gutter while the text
-- inside it sat at the body margin instead of 15.6pt in. Measured before the
-- change: ink -8.880, text +0.000. Both are now +0.000 and +15.60.
--
-- `w:sz="8"` renders 0.96pt, not the nominal 1pt, which is where 19 and 10 come
-- from. tcolorbox's rule is 1.417pt and `w:sz="11"/"12"` would match it better,
-- but FRAME_TW and FRAME_HALF both move with it -- re-probe in real Word rather
-- than scaling them on paper.
-- ============================================================================

local VARIANT = {
  id = "print",
  -- Paper readers cannot click. The print reference document also styles
  -- Hyperlink as plain black with no underline (config/docx-styles.js), so
  -- without this the URL is unrecoverable from the page -- exactly the reason
  -- generatePromptRefCallout() in callout-filter-print.lua appends
  -- \footnote{\url{...}}.
  promptRefUrlFootnote = true,

  --[[ Vertical space above and below a body-level box, twips.

       tcolorbox does not declare `before skip`/`after skip`, so the LaTeX boxes
       get \medskipamount, which is elastic -- the same gap measures anywhere from
       8.1 to 26.5pt in the print PDF depending on what the page had to absorb.
       Only the central tendency is meaningful. Medians over the whole book:

           body paragraph -> box    12.663pt
           box            -> box     9.760pt
           box            -> body   12.855pt

       200tw = 10pt is the single value that lands closest to all three at once.
       Raising it to 220 would fix the third at the cost of the other two. ]]
  gap = 200,

  --[[ Vertical space between two conversation speaker turns, twips.
       Print PDF median 5.454pt over 29 consecutive turn pairs; 110tw = 5.5pt. ]]
  turnGap = 110,
}

local FRAME_SZ   = 8    -- eighths of a point; Word renders this as 0.96pt
local FRAME_TW   = 19   -- ...which is 19 twips, the width the box must give back
local FRAME_HALF = 10   -- ...and half of it, rounded up, is the tblInd correction

local IND      = 312    -- w:tblInd = inner text inset: 15.60pt vs 15.591 target
local CODE_IND = 194    -- code callouts: 9.70pt vs 9.707 target
local TITLE_TOP, TITLE_BOT = 40, 40    -- 2pt around the title inside its band
local CELL_BOT = 120    -- 6pt; measures 9.18pt from the last glyph to the frame,
                        -- against the print PDF's 9.06pt typical

--[[ Top margin of the content cell -- the gap under the coloured title band.

     Two values, because the band is followed by two structurally different
     things and Word treats them differently. A TEXT line arrives inside a line
     box whose half-leading already eats into the gap (BodyText is
     `line=288 auto`); a nested table -- every conversation turn -- has none, so
     the same margin reads ~2pt tighter under text than under a box.

     Print PDF, measured from the BOTTOM OF THE TITLE CHIP -- and the chip is
     drawn as an outer rect plus an inner one, so it is the OUTER y1 that is the
     visible bottom edge. Measuring the inner rect instead reads 1.92pt high and
     will send you 90 twips in the wrong direction:
         chip bottom -> first text glyph     6.275pt  (median, n=137)
         chip bottom -> first turn box       6.765pt  (n=14, all agreeing to
                                                       within 0.001pt)

     Calibrated in real Word against the same quantity, measured from where the
     accent colour stops (band fill plus the accent row-separator rule):
         120tw -> 7.857 text / 6.000 box      31tw -> 3.537 text
          78tw -> 3.840 box
     which is 0.0485pt per twip under text and 0.0514 under a box, giving 87 and
     135. Note the shipped value of 120 was already close for both; do not
     "correct" it without re-measuring from the outer chip rect. ]]
local CELL_TOP_TEXT = 87
local CELL_TOP_BOX  = 135

local TURN_FRAME_SZ = 4   -- 0.5pt, mirroring the turns' `boxrule=0.5pt`
local TURN_FRAME_TW = 10
local TURN_IND = 0        -- nested tables obey the OTHER law (see the primitives
                          -- header): tblInd moves their INK, and 0 already puts
                          -- it on the containing cell's text origin -- which is
                          -- where the print PDF puts a turn box, on all 44 of them
local TURN_PAD = 171      -- ...so the whole inset is the cell margin: 8.55pt plus
                          -- half the 0.48pt rule = 8.79pt vs the 8.787pt target
local TURN_TOP, TURN_BOT = 60, 60

--- Opening fragment for a callout box.
--- @return table blocks, number inner_w  -- usable width inside the content cell
local function openCallout(color, width, title, callout_type)
  local accent = shade(color, 75)
  local frame = frame_borders(accent, FRAME_SZ)
  local ind = (callout_type == "code") and CODE_IND or IND
  local mar = ind - FRAME_HALF     -- pins the frame's ink on the text margin
  local w = width - FRAME_TW       -- ...and its right edge on the right margin
  -- A conversation opens with a nested turn box; everything else opens with text.
  local top = (callout_type == "conversation") and CELL_TOP_BOX or CELL_TOP_TEXT
  return {
    raw(table.concat({
      tbl_open({ w }, ind),
      -- title band
      '<w:tr><w:trPr><w:cantSplit/></w:trPr>',
        tc_open(w, accent, tc_mar(TITLE_TOP, mar, TITLE_BOT, mar), frame),
        title_xml(title, "FFFFFF", 0, 0),
      '</w:tc></w:tr>',
      -- body
      '<w:tr>',
        tc_open(w, tint(color, 5), tc_mar(top, mar, CELL_BOT, mar), frame),
    })),
  }, w - 2 * mar
end

--- Opening fragment for one conversation speaker turn (nested inside a callout).
--- Mirrors `colback=<speaker>!10!white, colframe=<speaker>!50!black,
--- boxrule=0.5pt` (0.5pt = w:sz 4). NOT the same arithmetic as the outer box:
--- nested tables follow the second law in the primitives header, where the cell
--- margin insets the text without displacing the border, so there is no tblInd
--- correction to make here.
--- @return table blocks, number inner_w
local function openTurn(spec, width)
  local w = width - TURN_FRAME_TW
  return {
    raw(table.concat({
      tbl_open({ w }, TURN_IND),
      '<w:tr>',
        tc_open(w, tint(spec.color, 10), tc_mar(TURN_TOP, TURN_PAD, TURN_BOT, TURN_PAD),
                frame_borders(shade(spec.color, 50), TURN_FRAME_SZ)),
    })),
  }, w - 2 * TURN_PAD
end

-- ============================================================================
-- END VARIANT: print
-- ============================================================================

-- ============================================================================
-- BEGIN SHARED DOCX BODY
-- ----------------------------------------------------------------------------
-- Byte-identical in callout-filter-docx-digital.lua and
-- callout-filter-docx-print.lua. Everything here is SEMANTICS -- which blocks go
-- into the box and in what order -- and is deliberately free of any geometry: the
-- two spacer heights it needs come from VARIANT.gap and VARIANT.turnGap, never
-- as literals, so the only thing the two filters can disagree about is the
-- chrome defined in the VARIANT region above. Copy this whole region across if
-- you edit it.
-- ============================================================================

--[[ Closing fragment for any box opened by openCallout()/openTurn(), plus the
     spacer that follows the table.

     `trailing` is that spacer's height in twips, and the two call sites want
     very different things from it:

       * a body-level callout passes VARIANT.gap -- real, visible space below the
         box, which is half of defect 3;
       * a conversation turn passes HAIRLINE, because the turn sits INSIDE a cell
         whose own bottom margin already provides the padding. There the spacer
         is structural only: it legally terminates the cell (a cell may not end
         with a `<w:tbl>`) and it keeps this turn from fusing with the next one.

     Either way a spacer is always emitted. It is never safe to drop. ]]
local function close_box(trailing)
  return { raw('</w:tc></w:tr></w:tbl>'), spacer(trailing) }
end

--- Twin of startsWithBoldMarker() in callout-filter-{digital,print}.lua.
local function starts_with_bold_marker(para, marker)
  if not para.content or #para.content == 0 then
    return false
  end
  local first = para.content[1]
  if first.t ~= "Strong" then
    return false
  end
  local text = pandoc.utils.stringify(first)
  return text == marker or text == marker .. ":"
end

--- Twin of extractMessageInlines() in callout-filter-{digital,print}.lua: the
--- inlines that follow a leading bold speaker marker.
local function extract_message_inlines(para)
  local start_idx = 2
  if #para.content > 1 and para.content[2].t == "Space" then
    start_idx = 3
  end
  local inlines = {}
  for i = start_idx, #para.content do
    inlines[#inlines + 1] = para.content[i]
  end
  return inlines
end

--[[ One conversation turn as a nested box. Mirrors the LaTeX anatomy
     `\textbf{Human:} message` -- the label is bold and only the MESSAGE is
     italicised for Reflection, which is why the marker is stripped and re-added
     rather than the whole paragraph being wrapped in an Emph.

     Note there is no LEADING spacer here, unlike a body-level callout. Space
     BETWEEN two turns comes from the previous turn's trailing VARIANT.turnGap
     spacer, and a leading one would also open a gap between the callout's title
     and its first turn -- where the print PDF puts 6.765pt, which is exactly the
     content cell's own top margin. ]]
local function turn_blocks(marker, para, width)
  local spec = speakers[marker]
  local message = extract_message_inlines(para)
  if spec.italic and #message > 0 then
    message = { pandoc.Emph(message) }
  end

  local inlines = { pandoc.Strong({ pandoc.Str(marker .. ":") }), pandoc.Space() }
  for _, inline in ipairs(message) do
    inlines[#inlines + 1] = inline
  end

  local out = openTurn(spec, width)
  out[#out + 1] = pandoc.Para(inlines)
  for _, b in ipairs(close_box(VARIANT.turnGap)) do
    out[#out + 1] = b
  end
  return out
end

--- Build the whole callout: leading spacer, opener, content blocks, closer.
local function generate(callout_type, elem)
  local cfg = callouts[callout_type]
  local color = cfg.color
  local title = cfg.title

  --[[ PROMPT REFERENCES ARE DATA RECOVERY, NOT STYLING.

       `::: {.promptref title="..." url="..."}` carries the prompt's name and
       link in elem.attributes, and the docx writer discards Div attributes
       outright. Without this filter all 67 prompt names and all 67 URLs vanish
       from the docx without a single warning -- the boxes would still look fine,
       they would just be missing the thing they exist to point at. Mirrors
       generatePromptRefCallout() in callout-filter-digital.lua. ]]
  if callout_type == "promptref" and elem.attributes.title and elem.attributes.title ~= "" then
    title = elem.attributes.title
  end

  --[[ The LEADING spacer, and the other half of defect 3.

       BodyText is `before=0 after=0` (it separates paragraphs with a first-line
       indent, not with space), so without this a body paragraph rests directly
       on the top of the following box -- measured 2.46pt, against 12.66pt in the
       print PDF. Nothing else in the document will supply that gap.

       It doubles as the anti-fusion fence in front of the box, which is why the
       Blocks pass below only has to worry about the cases this cannot reach. ]]
  local out = { spacer(VARIANT.gap) }

  local box, inner_w = openCallout(color, WIDTH, title, callout_type)
  for _, b in ipairs(box) do
    out[#out + 1] = b
  end

  -- A cell must end with a <w:p>. Track whether the last thing we handed to
  -- pandoc renders as a table (or whether we emitted nothing at all) so we can
  -- append a terminating paragraph.
  local emitted, ends_with_table = 0, false
  local function emit(block)
    out[#out + 1] = block
    emitted = emitted + 1
    ends_with_table = (block.t == "Table")
  end

  if callout_type == "conversation" then
    -- Speaker-turn structure, mirroring generateConversationCallout() in the
    -- LaTeX filters and generateHtmlConversationCallout() in the shared
    -- HTML/EPUB block. Narration, lists and code blocks pass through untouched.
    for _, block in ipairs(elem.content) do
      local matched = nil
      if block.t == "Para" then
        for _, marker in ipairs(speaker_order) do
          if starts_with_bold_marker(block, marker) then
            matched = marker
            break
          end
        end
      end
      if matched then
        for _, b in ipairs(turn_blocks(matched, block, inner_w)) do
          emit(b)
        end
      else
        emit(block)
      end
    end

  elseif callout_type == "promptref" then
    -- Anatomy, from generatePromptRefCallout(): description blocks, then (when
    -- there is more than one block) the elided prompt preview in italics, then
    -- a "Link: <prompt name>" footer.
    local n = #elem.content
    for i, block in ipairs(elem.content) do
      if i == n and n > 1 and block.t == "Para" then
        -- The web and epub paths italicise the preview in CSS
        -- (.callout-preview). A docx has no stylesheet to lean on, so the Emph
        -- has to be real. Checked against the 67 live callouts: no preview is
        -- written as *italic* in the source, so nothing is double-wrapped.
        emit(pandoc.Para({ pandoc.Emph(block.content) }))
      else
        emit(block)
      end
    end

    local url = elem.attributes.url
    if url and url ~= "" then
      -- A real pandoc.Link, so the docx writer builds an actual hyperlink
      -- relationship and the entry is clickable in Word.
      local inlines = {
        pandoc.Strong({ pandoc.Str("Link:") }),
        pandoc.Space(),
        pandoc.Link({ pandoc.Str(title) }, url),
      }
      if VARIANT.promptRefUrlFootnote then
        inlines[#inlines + 1] = pandoc.Note({ pandoc.Para({ pandoc.Code(url) }) })
      end
      emit(pandoc.Para(inlines))
    end

  else
    for _, block in ipairs(elem.content) do
      emit(block)
    end
  end

  if emitted == 0 or ends_with_table then
    out[#out + 1] = spacer(HAIRLINE)
  end

  for _, b in ipairs(close_box(VARIANT.gap)) do
    out[#out + 1] = b
  end
  return out
end

---------------------------------------------------------------------- hooks --

--- The raw fragments below are meaningful to the docx writer and to nothing
--- else. On any other target the Div is returned untouched, so its content still
--- renders (unboxed) instead of disappearing.
local function is_docx(fmt)
  return fmt == "docx" or fmt:find("openxml", 1, true) ~= nil
end

local function Meta(meta)
  if meta["docx-callout-width"] then
    local w = tonumber(pandoc.utils.stringify(meta["docx-callout-width"]))
    if w and w > 0 then
      WIDTH = math.floor(w)
    end
  end
  return meta
end

local function Div(elem)
  if not is_docx(FORMAT) then return nil end
  if not elem.classes or #elem.classes == 0 then return nil end

  local callout_type = elem.classes[1]

  -- Unknown class: leave the Div alone. `note`, `example` and `caution` appear
  -- in the repo README (which is not a book source) and neither the LaTeX nor
  -- the HTML filters know them either; falling through means their content is
  -- still written out, just without a box.
  if not callouts[callout_type] then return nil end

  return generate(callout_type, elem)
end

--- Does this block open one of our boxes?
local function is_box_start(b)
  return b.t == "RawBlock" and b.format == "openxml" and b.text:match("^%s*<w:tbl") ~= nil
end

--- Does this block END with a table, ours or pandoc's own?
local function ends_a_table(b)
  if b.t == "Table" then return true end
  return b.t == "RawBlock" and b.format == "openxml" and b.text:match("</w:tbl>%s*$") ~= nil
end

--[[ Second pass, with two jobs.

     COLLAPSE RUNS OF SPACERS. Every box now emits one before it and one after
     it, so two consecutive callouts produce two spacers back to back -- and
     spacers ADD (two 240tw spacers measured 25.92pt, not 12). Left alone, the
     gap between adjacent boxes would be exactly double the gap anywhere else.
     Keeping the taller of the run is what makes it safe for generate() to bracket
     every box unconditionally instead of having to know what precedes it.

     FENCE OFF ANYTHING WE DID NOT WRAP. See note 2 in the primitives header:
     Word fuses two adjacent `<w:tbl>` into one and rescales both. The leading
     spacer already covers a box that follows one of our boxes, but a NATIVE
     markdown table immediately followed by a callout is pandoc's block, not
     ours, and pandoc only separates two tables it recognises as tables. Real
     occurrence: the metrics table in ch9.md directly followed by `::: info`. ]]
local function Blocks(blocks)
  local out, changed = {}, false
  for _, b in ipairs(blocks) do
    local here = spacer_twips(b)
    local prev = out[#out]
    local before = prev and spacer_twips(prev) or nil
    if here and before then
      if here > before then out[#out] = b end
      changed = true
    elseif is_box_start(b) and prev and ends_a_table(prev) then
      out[#out + 1] = spacer(HAIRLINE)
      out[#out + 1] = b
      changed = true
    else
      out[#out + 1] = b
    end
  end
  if changed then return out end
  return nil
end

-- Meta must run to completion before Div, so that -M docx-callout-width is in
-- effect for the first callout; Blocks must run after Div so it can see the
-- boxes. Hence three separate traversals rather than one filter table.
return {
  { Meta = Meta },
  { Div = Div },
  { Blocks = Blocks },
}
-- ============================================================================
-- END SHARED DOCX BODY
-- ============================================================================
