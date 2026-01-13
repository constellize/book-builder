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
function extractLineNumbers(url)
  local lineMatch = url:match("#L(%d+)%-?L?(%d*)")
  if lineMatch then
    local startLine = tonumber(lineMatch)
    local endLine = lineMatch:match("%-L(%d+)") and tonumber(lineMatch:match("%-L(%d+)")) or startLine
    return startLine, endLine
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
function processLinkForLatex(elem)
  local url = elem.target
  local text = pandoc.utils.stringify(elem.content)
  
  if isRepositoryLink(url) then
    -- For code file links, add line number info
    if isCodeLink(url) then
      local fileType = getFileType(url)
      local startLine, endLine = extractLineNumbers(url)
      
      -- Create enhanced link with file type and line info
      local linkText = text
      if startLine then
        if endLine and endLine ~= startLine then
          linkText = linkText .. " (lines " .. startLine .. "-" .. endLine .. ")"
        else
          linkText = linkText .. " (line " .. startLine .. ")"
        end
      end
    end
    
    -- For PDF/print, all repository links get clickable text plus a footnote with the URL
    local footnoteText = "\\footnote{\\url{" .. url .. "}}"
    
    return {
      pandoc.Link(elem.content, url, elem.title),
      pandoc.RawInline("latex", footnoteText)
    }
  end
  
  return elem
end

-- Enhanced link processing for HTML output
function processLinkForHtml(elem)
  local url = elem.target
  local text = pandoc.utils.stringify(elem.content)
  
  if isRepositoryLink(url) then
    if isCodeLink(url) then
      local fileType = getFileType(url)
      local startLine, endLine = extractLineNumbers(url)
      
      -- Add CSS classes and data attributes for styling
      local attributes = {
        class = "repo-link code-link",
        ["data-file-type"] = fileType:lower(),
        target = "_blank",
        rel = "noopener noreferrer"
      }
      
      if startLine then
        attributes["data-start-line"] = tostring(startLine)
        if endLine and endLine ~= startLine then
          attributes["data-end-line"] = tostring(endLine)
        end
      end
      
      -- Create enhanced link element
      local link = pandoc.Link(elem.content, url, elem.title)
      link.attributes = attributes
      
      return link
    else
      -- Regular repository link
      local attributes = {
        class = "repo-link",
        target = "_blank",
        rel = "noopener noreferrer"
      }
      
      local link = pandoc.Link(elem.content, url, elem.title)
      link.attributes = attributes
      
      return link
    end
  end
  
  return elem
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
  elseif FORMAT:match "html" then
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
