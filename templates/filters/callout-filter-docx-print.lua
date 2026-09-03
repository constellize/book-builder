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
--    table. pandoc inserts a spacer paragraph between two NATIVE tables but has
--    no idea our RawBlocks are tables, so we insert our own (see the Blocks
--    pass at the bottom of the file). Real occurrence: the metrics table in
--    ch9.md immediately followed by an `::: info` callout.
-- 3. `<w:tblLayout w:type="fixed"/>` TOGETHER WITH `<w:tblW>` is required for a
--    full-width box; with autofit the box hugs its content. (Earlier reports of
--    "boxes shrink to content" despite fixed layout were macOS Quick Look
--    artifacts -- real Word and real LibreOffice both honour it.)
--
-- A table cell must also END with a `<w:p>`; a cell whose last child is a
-- `<w:tbl>` is invalid and Word repairs (i.e. silently rewrites) the document.
-- ============================================================================

--[[ Usable text width in twips.

     Read off the reference documents' section properties, which both variants
     share (templates/docx/src-{digital,print}/word/document.xml):

         <w:pgSz  w:w="12240" w:h="15840"/>                 US Letter
         <w:pgMar w:left="1440" w:right="1440" ... w:gutter="288"/>

     12240 - 1440 - 1440 - 288 = 9072.

     The 288-twip (0.2in) binding gutter is the reason this is not the familiar
     9360: a box drawn at 9360 overflows the text block by 0.2in on every single
     callout. Overridable with `-M docx-callout-width=<twips>` if the page
     geometry in config/docx-styles.js ever changes. ]]
local DEFAULT_WIDTH = 9072
local WIDTH = DEFAULT_WIDTH

local BAR = 60          -- accent bar column on a callout, twips (60tw = 3pt)
local TURN_BAR = 40     -- accent bar column on a conversation turn, twips
local PAD = 170         -- horizontal cell padding, twips
local TURN_PAD = 110    -- horizontal cell padding inside a conversation turn

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

--- `<w:tbl><w:tblPr>...<w:tblGrid>` opener. `cols` is a list of twip widths.
--- See note 1 above: this child order is load-bearing.
local function tbl_open(cols)
  local total, grid = 0, {}
  for _, w in ipairs(cols) do
    total = total + w
    grid[#grid + 1] = string.format('<w:gridCol w:w="%d"/>', w)
  end
  return table.concat({
    '<w:tbl><w:tblPr>',
      string.format('<w:tblW w:w="%d" w:type="dxa"/>', total),
      '<w:tblInd w:w="0" w:type="dxa"/>',
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

--- `<w:tc><w:tcPr>...</w:tcPr>` opener, left deliberately unclosed.
--- See note 1 above: this child order is load-bearing.
local function tc_open(w, fill, mar, borders)
  return table.concat({
    '<w:tc><w:tcPr>',
      string.format('<w:tcW w:w="%d" w:type="dxa"/>', w),
      borders or ('<w:tcBorders>' .. no_borders(false) .. '</w:tcBorders>'),
      string.format('<w:shd w:val="clear" w:color="auto" w:fill="%s"/>', fill),
      mar or tc_mar(120, PAD, 120, PAD),
    '</w:tcPr>',
  })
end

--- A 1pt-tall empty paragraph. Used to (a) legally terminate a cell whose last
--- real block is a table and (b) separate two body-level tables so Word does not
--- merge them (note 2 above).
local function empty_para_xml(after)
  return string.format(
    '<w:p><w:pPr><w:spacing w:before="0" w:after="%d" w:line="20" w:lineRule="exact"/>' ..
    '<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>', after)
end

local function tiny_para(after)
  return raw(empty_para_xml(after or 0))
end

--- Solid accent-coloured bar cell: a narrow extra table COLUMN rather than a
--- left border, because `w:shd` is honoured by every renderer tested while a
--- one-sided `w:tcBorders` is not.
local function bar_cell_xml(fill, width)
  return table.concat({
    tc_open(width, fill, tc_mar(0, 0, 0, 0)),
    empty_para_xml(0),
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
-- ============================================================================

local VARIANT = {
  id = "print",
  -- Paper readers cannot click. The print reference document also styles
  -- Hyperlink as plain black with no underline (config/docx-styles.js), so
  -- without this the URL is unrecoverable from the page -- exactly the reason
  -- generatePromptRefCallout() in callout-filter-print.lua appends
  -- \footnote{\url{...}}.
  promptRefUrlFootnote = true,
}

--- Opening fragment for a callout box.
--- @return table blocks, number inner_w  -- usable width inside the content cell
local function openCallout(color, width, title)
  local accent = shade(color, 75)
  local frame = frame_borders(accent, 8)
  return {
    raw(table.concat({
      tbl_open({ width }),
      -- title band
      '<w:tr><w:trPr><w:cantSplit/></w:trPr>',
        tc_open(width, accent, tc_mar(40, PAD, 40, PAD), frame),
        title_xml(title, "FFFFFF", 0, 0),
      '</w:tc></w:tr>',
      -- body
      '<w:tr>',
        tc_open(width, tint(color, 5), tc_mar(120, PAD, 120, PAD), frame),
    })),
  }, width - 2 * PAD
end

--- Opening fragment for one conversation speaker turn (nested inside a callout).
--- Mirrors `colback=<speaker>!10!white, colframe=<speaker>!50!black,
--- boxrule=0.5pt` (0.5pt = w:sz 4).
--- @return table blocks, number inner_w
local function openTurn(spec, width)
  return {
    raw(table.concat({
      tbl_open({ width }),
      '<w:tr>',
        tc_open(width, tint(spec.color, 10), tc_mar(60, TURN_PAD, 60, TURN_PAD),
                frame_borders(shade(spec.color, 50), 4)),
    })),
  }, width - 2 * TURN_PAD
end

-- ============================================================================
-- END VARIANT: print
-- ============================================================================

-- ============================================================================
-- BEGIN SHARED DOCX BODY
-- ----------------------------------------------------------------------------
-- Byte-identical in callout-filter-docx-digital.lua and
-- callout-filter-docx-print.lua. Everything here is SEMANTICS -- which blocks go
-- into the box and in what order -- and is deliberately free of any geometry, so
-- the only thing the two filters can disagree about is the chrome defined in the
-- VARIANT region above. Copy this whole region across if you edit it.
-- ============================================================================

--- Closing fragment for any box opened by openCallout()/openTurn(), plus the
--- body-level spacer that stops Word merging this table with the next one.
local function close_box(after)
  return { raw('</w:tc></w:tr></w:tbl>'), tiny_para(after) }
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

--- One conversation turn as a nested box. Mirrors the LaTeX anatomy
--- `\textbf{Human:} message` -- the label is bold and only the MESSAGE is
--- italicised for Reflection, which is why the marker is stripped and re-added
--- rather than the whole paragraph being wrapped in an Emph.
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
  for _, b in ipairs(close_box(60)) do
    out[#out + 1] = b
  end
  return out
end

--- Build the whole callout: opener, content blocks, closer.
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

  local out, inner_w = openCallout(color, WIDTH, title)

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
    out[#out + 1] = tiny_para(0)
  end

  for _, b in ipairs(close_box(120)) do
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

--- Second pass. See note 2 in the primitives header: Word merges two adjacent
--- `<w:tbl>` into one. Every box we emit is already followed by a spacer, but a
--- NATIVE markdown table immediately followed by a callout would still collide,
--- because pandoc only inserts its own spacer between two tables it knows about.
--- Real occurrence: the metrics table in ch9.md directly followed by `::: info`.
local function is_box_start(b)
  return b.t == "RawBlock" and b.format == "openxml" and b.text:match("^%s*<w:tbl") ~= nil
end

local function ends_a_table(b)
  if b.t == "Table" then return true end
  return b.t == "RawBlock" and b.format == "openxml" and b.text:match("</w:tbl>%s*$") ~= nil
end

local function Blocks(blocks)
  local out, changed = {}, false
  for _, b in ipairs(blocks) do
    if is_box_start(b) and out[#out] and ends_a_table(out[#out]) then
      out[#out + 1] = tiny_para(0)
      changed = true
    end
    out[#out + 1] = b
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
