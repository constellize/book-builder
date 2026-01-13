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

-- Generate conversation callout (chat-style with human/AI/reflection)
function generateConversationCallout(content)
  local latex = [[
\begin{tcolorbox}[
  colback=teal!5!white,
  colbacktitle=teal!5!white,
  coltitle=black,
  title={\textbf{Conversation}},
  fonttitle=\small,
  frame hidden,
  breakable,
  enhanced,
  rounded corners,
  arc=3pt,
  boxrule=0pt,
  toptitle=0.3em,
  bottomtitle=0.3em,
  left=8pt,
  overlay={
    \fill[teal!75!black]
      ([xshift=3pt]frame.north west)
      arc[start angle=90, end angle=180, radius=3pt]
      -- ([yshift=3pt]frame.south west)
      arc[start angle=180, end angle=270, radius=3pt]
      -- ([xshift=4pt]frame.south west)
      -- ([xshift=4pt]frame.north west)
      -- cycle;
  },
  left=1em,
  right=1em,
  top=0.5em,
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
  frame hidden,
  boxrule=0pt,
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
  frame hidden,
  boxrule=0pt,
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
  frame hidden,
  boxrule=0pt,
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

-- Generate prompt reference callout (prominent link with preview)
-- Anatomy: title (prompt name), url (prompt link), content (description + preview)
-- Content structure: First paragraph(s) = description, last paragraph = preview (shown in italics)
-- Renders: description, preview in italics (elided), then "Link: [prompt name]"
function generatePromptRefCallout(content, elem)
  -- Extract title (prompt name) and URL (prompt link) from attributes
  local promptName = elem.attributes.title or "Prompt Reference"
  local promptUrl = elem.attributes.url or "#"

  local latex = string.format([[
\begin{tcolorbox}[
  colback=cyan!5!white,
  colbacktitle=cyan!5!white,
  coltitle=black,
  title={\textbf{%s}},
  fonttitle=\small,
  frame hidden,
  breakable,
  enhanced,
  rounded corners,
  arc=3pt,
  boxrule=0pt,
  toptitle=0.3em,
  bottomtitle=0.3em,
  left=8pt,
  overlay={
    \fill[cyan!75!black]
      ([xshift=3pt]frame.north west)
      arc[start angle=90, end angle=180, radius=3pt]
      -- ([yshift=3pt]frame.south west)
      arc[start angle=180, end angle=270, radius=3pt]
      -- ([xshift=4pt]frame.south west)
      -- ([xshift=4pt]frame.north west)
      -- cycle;
  },
  left=1em,
  right=1em,
  top=0.5em,
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

  -- Add link at bottom: "Link: [prompt name]" (digital version - clickable)
  latex = latex .. string.format([[

\vspace{0.5em}
\noindent\textcolor{cyan!75!black}{\textbf{Link:}} \href{%s}{%s}
]], promptUrl, promptName)

  latex = latex .. "\n\\end{tcolorbox}"
  return pandoc.RawBlock("latex", latex)
end

-- Generate LaTeX callout box (no emojis) - Clean modern style
function generateLatexCallout(calloutType, content, elem)
  local config = callouts[calloutType]
  if not config then
    return nil
  end

  -- Clean modern style: colored title bar, straight left bar, no rounded corners
  -- Code callouts: 0.5em content left/right
  -- Other callouts: 1em content left/right
  local contentMargins = ""

  if calloutType == "code" then
    contentMargins = ",\n  left=0.5em,\n  right=0.5em,\n  top=0.5em,\n  bottom=0.5em"
  else
    contentMargins = ",\n  left=1em,\n  right=1em,\n  top=0.5em,\n  bottom=0.5em"
  end

  -- Clean box with rounded corners and curved left bar matching box corners
  local latex = string.format([[
\begin{tcolorbox}[
  colback=%s!5!white,
  colbacktitle=%s!5!white,
  coltitle=black,
  title={\textbf{%s}},
  fonttitle=\small,
  frame hidden,
  breakable,
  enhanced,
  rounded corners,
  arc=3pt,
  boxrule=0pt,
  toptitle=0.3em,
  bottomtitle=0.3em,
  left=8pt,
  overlay={
    \fill[%s!75!black]
      ([xshift=3pt]frame.north west)
      arc[start angle=90, end angle=180, radius=3pt]
      -- ([yshift=3pt]frame.south west)
      arc[start angle=180, end angle=270, radius=3pt]
      -- ([xshift=4pt]frame.south west)
      -- ([xshift=4pt]frame.north west)
      -- cycle;
  }%s
]
]], config.latexcolor, config.latexcolor, config.title, config.latexcolor, contentMargins)

  -- Add content
  for _, block in ipairs(content) do
    latex = latex .. pandoc.write(pandoc.Pandoc({block}), "latex") .. "\n"
  end

  latex = latex .. "\\end{tcolorbox}"

  return pandoc.RawBlock("latex", latex)
end

-- Generate HTML callout box (no emojis)
function generateHtmlCallout(calloutType, content)
  local config = callouts[calloutType]
  if not config then
    return nil
  end
  
  local html = string.format([[
<div class="callout callout-%s" style="border-left: 4px solid %s; background-color: %s10; padding: 1rem; margin: 1rem 0;">
  <div class="callout-title" style="font-weight: bold; color: %s; margin-bottom: 0.5rem;">
    %s
  </div>
  <div class="callout-content">
]], config.style, config.htmlcolor, config.htmlcolor, config.htmlcolor, config.title)
  
  -- Add content
  for _, block in ipairs(content) do
    html = html .. pandoc.write(pandoc.Pandoc({block}), "html") .. "\n"
  end
  
  html = html .. [[
  </div>
</div>
]]
  
  return pandoc.RawBlock("html", html)
end

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
  elseif FORMAT:match "html" then
    return generateHtmlCallout(calloutType, elem.content)
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
