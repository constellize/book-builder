--[[
Callout Filter for Constellize Book
Processes custom callout syntax in markdown and converts to appropriate format
]]--

-- Callout configurations (without emoji icons for PDF compatibility)
local callouts = {
  info = {
    title = "Info",
    style = "info",
    latexcolor = "blue",
    htmlcolor = "#0066cc"
  },
  code = {
    title = "Code",
    style = "primary",
    latexcolor = "violet",
    htmlcolor = "#6f42c1"
  },
  success = {
    title = "Success",
    style = "success",
    latexcolor = "green",
    htmlcolor = "#28a745"
  },
  warning = {
    title = "Warning",
    style = "warning",
    latexcolor = "orange",
    htmlcolor = "#ffc107"
  },
  error = {
    title = "Error",
    style = "danger",
    latexcolor = "red",
    htmlcolor = "#dc3545"
  },
  conversation = {
    title = "Conversation",
    style = "conversation",
    latexcolor = "teal",
    htmlcolor = "#20c997"
  },
  promptref = {
    title = "Prompt Reference",
    style = "promptref",
    latexcolor = "cyan",
    htmlcolor = "#17a2b8"
  }
}

-- Helper function to check if a paragraph starts with a bold marker
function startsWithBoldMarker(para, marker)
  if not para.content or #para.content == 0 then
    return false
  end

  local first = para.content[1]
  if first.t == "Strong" then
    local strong_text = pandoc.utils.stringify(first)
    return strong_text == marker or strong_text == marker .. ":"
  end
  return false
end

-- Helper function to extract message after bold marker
function extractMessageAfterMarker(para)
  -- Skip the first Strong element and any following Space
  local start_idx = 2
  if #para.content > 1 and para.content[2].t == "Space" then
    start_idx = 3
  end

  -- Extract remaining content
  local message_inlines = {}
  for i = start_idx, #para.content do
    table.insert(message_inlines, para.content[i])
  end

  -- Convert to latex
  local message_para = pandoc.Para(message_inlines)
  return pandoc.write(pandoc.Pandoc({message_para}), "latex")
end

-- Generate conversation callout (chat-style with human/AI/reflection) - Print style
function generateConversationCallout(content)
  local latex = [[
\begin{tcolorbox}[
  colback=teal!5!white,
  colframe=teal!75!black,
  title={Conversation},
  breakable,
  enhanced,
  attach boxed title to top left={yshift=-2mm, xshift=2mm},
  boxed title style={size=small,colback=teal!75!black},
  top=0.75em,
  bottom=0.5em
]

]]

  -- Process content to identify Human/AI/Reflection parts
  for _, block in ipairs(content) do
    if block.t == "Para" then
      -- Check for Human, AI, or Reflection markers
      if startsWithBoldMarker(block, "Human") then
        local message = extractMessageAfterMarker(block)
        latex = latex .. string.format([[
\begin{tcolorbox}[
  colback=blue!10!white,
  colframe=blue!50!black,
  boxrule=0.5pt,
  left=0.5em,
  right=0.5em,
  top=0.3em,
  bottom=0.3em,
  before skip=0.5em,
  after skip=0.5em
]
\textbf{Human:} %s
\end{tcolorbox}

]], message)
      elseif startsWithBoldMarker(block, "AI") then
        local message = extractMessageAfterMarker(block)
        latex = latex .. string.format([[
\begin{tcolorbox}[
  colback=green!10!white,
  colframe=green!50!black,
  boxrule=0.5pt,
  left=0.5em,
  right=0.5em,
  top=0.3em,
  bottom=0.3em,
  before skip=0.5em,
  after skip=0.5em
]
\textbf{AI:} %s
\end{tcolorbox}

]], message)
      elseif startsWithBoldMarker(block, "Reflection") then
        local message = extractMessageAfterMarker(block)
        latex = latex .. string.format([[
\vspace{0.5em}
\begin{tcolorbox}[
  colback=orange!10!white,
  colframe=orange!50!black,
  boxrule=0.5pt,
  left=0.5em,
  right=0.5em,
  top=0.3em,
  bottom=0.3em,
  before skip=0.5em
]
\textbf{Reflection:} \textit{%s}
\end{tcolorbox}

]], message)
      else
        -- Regular content
        latex = latex .. pandoc.write(pandoc.Pandoc({block}), "latex") .. "\n"
      end
    else
      -- Non-paragraph blocks
      latex = latex .. pandoc.write(pandoc.Pandoc({block}), "latex") .. "\n"
    end
  end

  latex = latex .. "\\end{tcolorbox}"
  return pandoc.RawBlock("latex", latex)
end

-- Generate prompt reference callout (prominent link with preview) - Print style
-- Anatomy: title (prompt name), url (prompt link), content (description + preview)
-- Content structure: First paragraph(s) = description, last paragraph = preview (shown in italics)
-- Renders: description, preview in italics (elided), then "Link: [prompt name]" with footnote
function generatePromptRefCallout(content, elem)
  -- Extract title (prompt name) and URL (prompt link) from attributes
  local promptName = elem.attributes.title or "Prompt Reference"
  local promptUrl = elem.attributes.url or "#"

  local latex = string.format([[
\begin{tcolorbox}[
  colback=cyan!5!white,
  colframe=cyan!75!black,
  title={%s},
  breakable,
  enhanced,
  attach boxed title to top left={yshift=-2mm, xshift=2mm},
  boxed title style={size=small,colback=cyan!75!black},
  top=0.75em,
  bottom=0.5em
]

]], promptName)

  -- Separate content into description (all but last paragraph) and preview (last paragraph)
  local numBlocks = #content
  
  if numBlocks > 1 then
    -- Multiple blocks: description is all but last, preview is last
    for i = 1, numBlocks - 1 do
      latex = latex .. pandoc.write(pandoc.Pandoc({content[i]}), "latex") .. "\n"
    end
    
    -- Add preview in italics
    local previewText = pandoc.write(pandoc.Pandoc({content[numBlocks]}), "latex")
    latex = latex .. string.format([[

\vspace{0.3em}
\noindent\textit{%s}
]], previewText)
  else
    -- Single block: treat as description only
    for _, block in ipairs(content) do
      latex = latex .. pandoc.write(pandoc.Pandoc({block}), "latex") .. "\n"
    end
  end

  -- Add link at bottom: "Link: [prompt name]" with footnote showing full URL
  -- For print version, footnotes make URLs accessible to readers
  latex = latex .. string.format([[

\vspace{0.5em}
\noindent\textcolor{cyan!75!black}{\textbf{Link:}} \href{%s}{%s}\footnote{\url{%s}}
]], promptUrl, promptName, promptUrl)

  latex = latex .. "\n\\end{tcolorbox}"
  return pandoc.RawBlock("latex", latex)
end

-- Generate LaTeX callout box (no emojis)
function generateLatexCallout(calloutType, content, elem)
  local config = callouts[calloutType]
  if not config then
    return nil
  end
  
  -- Special formatting for code callouts only (reduced horizontal margins)
  local extraOptions = ""
  if calloutType == "code" then
    extraOptions = ",\n  left=0.5em,\n  right=0.5em"
  end

  local latex = string.format([[
\begin{tcolorbox}[
  colback=%s!5!white,
  colframe=%s!75!black,
  title={%s},
  breakable,
  enhanced,
  attach boxed title to top left={yshift=-2mm, xshift=2mm},
  boxed title style={size=small,colback=%s!75!black},
  top=0.75em,
  bottom=0.5em%s
]
]], config.latexcolor, config.latexcolor, config.title, config.latexcolor, extraOptions)
  
  -- Add content
  for _, block in ipairs(content) do
    latex = latex .. pandoc.write(pandoc.Pandoc({block}), "latex") .. "\n"
  end
  
  latex = latex .. "\\end{tcolorbox}"
  
  return pandoc.RawBlock("latex", latex)
end

-- ============================================================================
-- BEGIN SHARED HTML/EPUB BLOCK
-- ----------------------------------------------------------------------------
-- This block is byte-identical in callout-filter-digital.lua and
-- callout-filter-print.lua. Those two filters are meant to differ ONLY in their
-- LaTeX bodies; if you edit anything between the BEGIN/END markers, copy the
-- whole block into the sibling file so the two cannot drift.
--
-- Design decisions:
--  * We build real pandoc AST (Div / Span / Link) instead of
--    RawBlock("html", ...). Raw HTML *does* survive into epub3 (verified with
--    pandoc 3.8.3), but it then has to be hand-written as valid XHTML and has
--    to escape its own text. Emitting AST lets pandoc's html5 and epub3 writers
--    do both correctly, and keeps titles/URLs containing & or < safe.
--  * The filter emits CLASS NAMES ONLY -- no inline styles. Every visual
--    property lives in templates/book-template.html5 (web, development) and
--    styles/epub.css (epub). Those two files are the single source of truth for
--    callout appearance.
--  * Class contract:
--      div.callout.callout-<type>
--        > div.callout-title
--        > div.callout-content
--    where <type> is the fenced-div class: info, code, success, warning, error,
--    conversation, promptref. Conversation turns add
--    div.callout-turn.callout-turn-{human,ai,reflection} with span.callout-speaker.
--    Prompt references add div.callout-preview and
--    div.callout-link > span.callout-link-label + <a>.
-- ============================================================================

-- Writers that consume the HTML class contract above.
-- Verified with pandoc 3.8.3: FORMAT is exactly "html", "html5", "epub",
-- "epub3", "chunkedhtml", ... so `FORMAT:match "html"` on its own misses every
-- epub writer, which is why epub previously got no callout treatment at all.
function isHtmlFamily(fmt)
  return fmt:match("html") ~= nil or fmt:match("epub") ~= nil
end

-- Standard callout container.
function buildCalloutDiv(calloutType, titleInlines, bodyBlocks)
  local blocks = {}
  if titleInlines and #titleInlines > 0 then
    table.insert(blocks, pandoc.Div(
      { pandoc.Plain(titleInlines) },
      pandoc.Attr("", { "callout-title" })
    ))
  end
  table.insert(blocks, pandoc.Div(
    bodyBlocks,
    pandoc.Attr("", { "callout-content" })
  ))
  return pandoc.Div(blocks, pandoc.Attr("", { "callout", "callout-" .. calloutType }))
end

-- Inlines following a leading bold speaker marker. HTML twin of
-- extractMessageAfterMarker(), which returns rendered LaTeX source instead.
function extractMessageInlines(para)
  local start_idx = 2
  if #para.content > 1 and para.content[2].t == "Space" then
    start_idx = 3
  end

  local inlines = {}
  for i = start_idx, #para.content do
    table.insert(inlines, para.content[i])
  end
  return inlines
end

-- Generic HTML/EPUB callout: title from the callouts table, content verbatim.
function generateHtmlCallout(calloutType, content)
  local config = callouts[calloutType]
  if not config then
    return nil
  end

  return buildCalloutDiv(calloutType, { pandoc.Str(config.title) }, content)
end

-- HTML/EPUB twin of generateConversationCallout(): preserves the speaker-turn
-- structure that the LaTeX version builds out of nested tcolorboxes, so web and
-- epub readers get the same Human / AI / Reflection framing as the PDFs.
function generateHtmlConversationCallout(content)
  local speakers = {
    { marker = "Human",      slug = "human",      label = "Human:",      italic = false },
    { marker = "AI",         slug = "ai",         label = "AI:",         italic = false },
    { marker = "Reflection", slug = "reflection", label = "Reflection:", italic = true  }
  }

  local body = {}
  for _, block in ipairs(content) do
    local matched = nil
    if block.t == "Para" then
      for _, speaker in ipairs(speakers) do
        if startsWithBoldMarker(block, speaker.marker) then
          matched = speaker
          break
        end
      end
    end

    if matched then
      local message = extractMessageInlines(block)
      if matched.italic then
        message = { pandoc.Emph(message) }
      end

      local inlines = {
        pandoc.Span({ pandoc.Str(matched.label) }, pandoc.Attr("", { "callout-speaker" })),
        pandoc.Space()
      }
      for _, inline in ipairs(message) do
        table.insert(inlines, inline)
      end

      table.insert(body, pandoc.Div(
        { pandoc.Para(inlines) },
        pandoc.Attr("", { "callout-turn", "callout-turn-" .. matched.slug })
      ))
    else
      -- Non-speaker blocks (narration, lists, code) pass through untouched.
      table.insert(body, block)
    end
  end

  return buildCalloutDiv("conversation", { pandoc.Str(callouts.conversation.title) }, body)
end

-- HTML/EPUB twin of generatePromptRefCallout(). Mirrors the LaTeX anatomy:
--   title  = prompt name, taken from the div's `title` attribute
--   body   = description blocks; when there is more than one block the last one
--            is the elided prompt preview and is rendered in italics
--   footer = "Link: <prompt name>" as a real anchor on the div's `url`
-- Before this existed the HTML path called generateHtmlCallout() without `elem`,
-- so all 67 prompt names and URLs in the book were silently dropped from web
-- and epub output.
function generateHtmlPromptRefCallout(content, elem)
  local promptName = elem.attributes.title or callouts.promptref.title
  local promptUrl = elem.attributes.url or "#"

  local body = {}
  local numBlocks = #content

  if numBlocks > 1 then
    -- Multiple blocks: description is all but last, preview is last.
    for i = 1, numBlocks - 1 do
      table.insert(body, content[i])
    end

    -- The preview is italicised by CSS (.callout-preview), not by wrapping it in
    -- an Emph here: most previews are already written as *italic* in the source,
    -- and wrapping again produced <em><em>...</em></em>.
    table.insert(body, pandoc.Div(
      { content[numBlocks] },
      pandoc.Attr("", { "callout-preview" })
    ))
  else
    -- Single block: treat as description only.
    for _, block in ipairs(content) do
      table.insert(body, block)
    end
  end

  table.insert(body, pandoc.Div({
    pandoc.Para({
      pandoc.Span({ pandoc.Str("Link:") }, pandoc.Attr("", { "callout-link-label" })),
      pandoc.Space(),
      pandoc.Link({ pandoc.Str(promptName) }, promptUrl)
    })
  }, pandoc.Attr("", { "callout-link" })))

  return buildCalloutDiv("promptref", { pandoc.Str(promptName) }, body)
end
-- ============================================================================
-- END SHARED HTML/EPUB BLOCK
-- ============================================================================

-- Main filter function for Div elements (fenced divs like ::: info)
function Div(elem)
  -- Check if this is a callout div
  if not elem.classes or #elem.classes == 0 then
    return elem
  end

  -- Get the callout type from the first class
  local calloutType = elem.classes[1]

  -- Check if it's a recognized callout type
  if not callouts[calloutType] then
    return elem -- Not a recognized callout, return unchanged
  end

  -- Generate appropriate output based on format
  if FORMAT:match "latex" then
    -- Special handling for conversation and promptref
    if calloutType == "conversation" then
      return generateConversationCallout(elem.content)
    elseif calloutType == "promptref" then
      return generatePromptRefCallout(elem.content, elem)
    else
      return generateLatexCallout(calloutType, elem.content, elem)
    end
  elseif isHtmlFamily(FORMAT) then
    -- Same dispatch shape as the LaTeX branch above: conversation and promptref
    -- have dedicated renderers, everything else uses the generic box.
    if calloutType == "conversation" then
      return generateHtmlConversationCallout(elem.content)
    elseif calloutType == "promptref" then
      return generateHtmlPromptRefCallout(elem.content, elem)
    else
      return generateHtmlCallout(calloutType, elem.content)
    end
  else
    -- For other formats, return enhanced div
    return elem
  end
end

-- Return the filter
return {
  {
    Div = Div
  }
}
