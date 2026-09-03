--[[
Link Filter for Constellize Book
Processes repository links and ensures they work correctly in different output formats
]]--

-- URL patterns and full URLs (read from metadata)
local codepromptu_pattern = nil
local site_pattern = nil

-- Full URLs for fallback replacement (also from metadata)
local codepromptu_url = nil
local site_url = nil

-- Initialize patterns and URLs from document metadata
function Meta(meta)
  if meta['codepromptu-repo-pattern'] then
    codepromptu_pattern = pandoc.utils.stringify(meta['codepromptu-repo-pattern'])
    -- Derive full URL from pattern
    codepromptu_url = "https://" .. codepromptu_pattern .. "/blob/main"
  end
  if meta['site-pattern'] then
    site_pattern = pandoc.utils.stringify(meta['site-pattern'])
    -- Derive full URL from pattern
    site_url = "https://" .. site_pattern
  end
  return meta
end

-- Helper to escape special Lua pattern characters
function escapePattern(str)
  if not str then return nil end
  return str:gsub("([%.%-%+%*%?%[%]%^%$%(%)%%])", "%%%1")
end

-- Helper function to check if a link is a repository/site link
-- Checks for both placeholder syntax (if not yet replaced) and actual URLs
function isRepositoryLink(url)
  -- Check for placeholder syntax (may not be replaced yet)
  if url:match("{CODEPROMPTU_REPO_BASE}") or
     url:match("{SITE_BASE}") then
    return true
  end
  
  -- Check for actual expanded URLs using patterns from metadata
  if codepromptu_pattern and url:match(escapePattern(codepromptu_pattern)) then
    return true
  end
  if site_pattern and url:match(escapePattern(site_pattern)) then
    return true
  end
  
  return false
end

-- Helper function to check if a link is a site link
function isSiteLink(url)
  if url:match("{SITE_BASE}") then return true end
  if site_pattern and url:match(escapePattern(site_pattern)) then return true end
  return false
end

-- Helper function to check if a link is a CodePromptu repository link
function isCodepromptuRepoLink(url)
  if url:match("{CODEPROMPTU_REPO_BASE}") then return true end
  if codepromptu_pattern and url:match(escapePattern(codepromptu_pattern)) then return true end
  return false
end

-- Helper function to check if a link points to a code file
function isCodeLink(url)
  -- Pre-escaped extension patterns for Lua pattern matching
  local codeExtensionPatterns = {"%.java", "%.js", "%.ts", "%.py", "%.go", "%.rs", "%.cpp", "%.c", "%.h", "%.hpp", "%.md", "%.yml", "%.yaml", "%.json", "%.xml", "%.sql", "%.sh", "dockerfile"}
  
  local lowerUrl = url:lower()
  for _, extPattern in ipairs(codeExtensionPatterns) do
    if lowerUrl:match(extPattern .. "$") or lowerUrl:match(extPattern .. "#") then
      return true
    end
  end
  
  return false
end

-- Helper function to extract line numbers from URL fragment
-- Handles the two GitHub fragment shapes: "#L12-L40" (range) and "#L12" (single).
-- NOTE: the previous implementation did `local lineMatch = url:match(...)` on a
-- two-capture pattern, which kept only the FIRST capture and then searched that
-- capture ("12") for "-L(%d+)". That search could never succeed, so endLine was
-- always forced equal to startLine and the end of every range was silently lost.
function extractLineNumbers(url)
  local rangeStart, rangeEnd = url:match("#L(%d+)%-L(%d+)")
  if rangeStart then
    return tonumber(rangeStart), tonumber(rangeEnd)
  end

  local singleLine = url:match("#L(%d+)")
  if singleLine then
    local n = tonumber(singleLine)
    return n, n
  end

  return nil, nil
end

-- Helper function to get file type from extension
function getFileType(url)
  if url:match("%.java$") or url:match("%.java#") then
    return "Java"
  elseif url:match("%.js$") or url:match("%.js#") then
    return "JavaScript"
  elseif url:match("%.ts$") or url:match("%.ts#") then
    return "TypeScript"
  elseif url:match("%.py$") or url:match("%.py#") then
    return "Python"
  elseif url:match("%.md$") or url:match("%.md#") then
    return "Markdown"
  elseif url:match("%.yml$") or url:match("%.yml#") or url:match("%.yaml$") or url:match("%.yaml#") then
    return "YAML"
  elseif url:match("%.json$") or url:match("%.json#") then
    return "JSON"
  elseif url:match("%.sql$") or url:match("%.sql#") then
    return "SQL"
  elseif url:match("%.sh$") or url:match("%.sh#") then
    return "Shell"
  elseif url:match("[Dd]ockerfile") then
    return "Docker"
  else
    return "Code"
  end
end

-- Enhanced link processing for LaTeX output
--
-- The "(lines 12-40)" annotation is deliberately NOT applied here. The previous
-- code computed fileType/startLine/endLine and a `linkText` string, then threw
-- all four away -- the annotation never reached any PDF. It is deleted rather
-- than wired up because switching it on would rewrite the visible text of every
-- repository link in both the digital and print PDFs, and those two targets are
-- required to stay byte-comparable. The information is not lost: the footnote
-- below prints the full URL, fragment included, so "#L12-L40" is already visible
-- to a print reader. The annotation IS live in HTML/EPUB -- see
-- processLinkForHtml, which emits it as data-start-line / data-end-line, and the
-- .code-link rules in templates/book-template.html5 and styles/epub.css, which
-- render it. If the PDFs should ever gain the same annotation, add it here and
-- re-baseline both PDF targets.
function processLinkForLatex(elem)
  local url = elem.target

  if isRepositoryLink(url) then
    -- For PDF/print, all repository links get clickable text plus a footnote with the URL
    local footnoteText = "\\footnote{\\url{" .. url .. "}}"

    return {
      pandoc.Link(elem.content, url, elem.title),
      pandoc.RawInline("latex", footnoteText)
    }
  end

  return elem
end

-- Writers that consume the repo-link / code-link classes below.
-- Verified with pandoc 3.8.3: FORMAT is exactly "html", "html5", "epub",
-- "epub3", "chunkedhtml", ... so `FORMAT:match "html"` on its own misses every
-- epub writer, which is why epub links previously got no treatment at all.
function isHtmlFamily(fmt)
  return fmt:match("html") ~= nil or fmt:match("epub") ~= nil
end

-- Build the Attr for an enhanced repository link.
--
-- Two corrections over the previous version:
--  * Classes go in the Attr's class list, not in a key/value attribute literally
--    named "class". The old form only happened to work because pandoc emitted
--    the (empty) class list and the stray attribute separately.
--  * Key/value attributes are supplied as an ORDERED list of pairs. The old code
--    used a Lua hash table, whose iteration order is unspecified, so the emitted
--    HTML attribute order changed from run to run and the output was not
--    reproducible.
function repositoryLinkAttr(elem, extraClasses, orderedAttrs)
  local classes = {}
  for _, class in ipairs(elem.classes) do
    table.insert(classes, class)
  end
  for _, class in ipairs(extraClasses) do
    table.insert(classes, class)
  end

  local attrs = {}
  for _, pair in ipairs(elem.attributes) do
    table.insert(attrs, { pair[1], pair[2] })
  end
  for _, pair in ipairs(orderedAttrs) do
    table.insert(attrs, pair)
  end

  return pandoc.Attr(elem.identifier, classes, attrs)
end

-- Enhanced link processing for HTML and EPUB output.
--
-- Unlike the LaTeX path, the file-type / line-number computation here is NOT
-- dead: it is emitted as data-file-type / data-start-line / data-end-line, and
-- the .code-link rules in templates/book-template.html5 and styles/epub.css turn
-- data-start-line / data-end-line into the visible "(lines 12-40)" annotation.
-- Keeping the annotation in CSS rather than in the AST means the same filter
-- output serves web and epub, and the annotation can be switched off by deleting
-- one CSS rule.
function processLinkForHtml(elem)
  local url = elem.target

  if not isRepositoryLink(url) then
    return elem
  end

  -- target="_blank" only means something in a browser: EPUB readers have no
  -- tabs, and some epub validators object to it, so it is html-only.
  local orderedAttrs = {}
  if FORMAT:match("html") then
    table.insert(orderedAttrs, { "target", "_blank" })
  end
  table.insert(orderedAttrs, { "rel", "noopener noreferrer" })

  local classes = { "repo-link" }

  if isCodeLink(url) then
    table.insert(classes, "code-link")
    table.insert(orderedAttrs, { "data-file-type", getFileType(url):lower() })

    local startLine, endLine = extractLineNumbers(url)
    if startLine then
      table.insert(orderedAttrs, { "data-start-line", tostring(startLine) })
      if endLine and endLine ~= startLine then
        table.insert(orderedAttrs, { "data-end-line", tostring(endLine) })
      end
    end
  end

  return pandoc.Link(elem.content, url, elem.title,
                     repositoryLinkAttr(elem, classes, orderedAttrs))
end

-- Main link processing function
function Link(elem)
  -- Skip processing if URL is empty or not a string
  if not elem.target or type(elem.target) ~= "string" then
    return elem
  end
  
  -- Process based on output format
  if FORMAT:match "latex" then
    return processLinkForLatex(elem)
  elseif isHtmlFamily(FORMAT) then
    return processLinkForHtml(elem)
  else
    -- For other formats, return as-is
    return elem
  end
end

-- Process code blocks that might contain repository references
function CodeBlock(elem)
  -- Look for repository URLs in code comments
  local content = elem.text
  local modified = false
  
  -- Replace {CODEPROMPTU_REPO_BASE} in code blocks (using URL from metadata)
  -- Note: The actual replacement should have been done by the build script
  -- This is just a fallback using metadata-derived URLs
  if content:match("{CODEPROMPTU_REPO_BASE}") and codepromptu_url then
    content = content:gsub("{CODEPROMPTU_REPO_BASE}", codepromptu_url)
    modified = true
  end
  
  -- Replace {SITE_BASE} in code blocks (using URL from metadata)
  if content:match("{SITE_BASE}") and site_url then
    content = content:gsub("{SITE_BASE}", site_url)
    modified = true
  end
  
  if modified then
    return pandoc.CodeBlock(content, elem.attr)
  end
  
  return elem
end

-- Process inline code that might contain repository references
function Code(elem)
  local content = elem.text
  local modified = false
  
  -- Replace {CODEPROMPTU_REPO_BASE} in inline code (using URL from metadata)
  if content:match("{CODEPROMPTU_REPO_BASE}") and codepromptu_url then
    content = content:gsub("{CODEPROMPTU_REPO_BASE}", codepromptu_url)
    modified = true
  end
  
  -- Replace {SITE_BASE} in inline code (using URL from metadata)
  if content:match("{SITE_BASE}") and site_url then
    content = content:gsub("{SITE_BASE}", site_url)
    modified = true
  end
  
  if modified then
    return pandoc.Code(content, elem.attr)
  end
  
  return elem
end

-- Return the filter functions
-- Meta must run first to initialize patterns, then Link/CodeBlock/Code
return {
  { Meta = Meta },
  { Link = Link, CodeBlock = CodeBlock, Code = Code }
}
