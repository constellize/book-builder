-- Test probe. Runs AFTER another filter and replaces the document with one line per
-- top-level block: "<Type>|<first 300 characters of its text, whitespace squeezed>".
--
-- 300, not 80: callout-filter-print.lua now opens each callout's raw block with a
-- `%%CALLOUTFIT` provenance comment (read by scripts/check-pinned-callouts.js), which is
-- longer than 80 characters on its own, and the thing the one test here asserts on is what
-- comes AFTER it in the same block.
--
-- It exists so a test can assert on the BLOCK STRUCTURE a filter produced while the writer
-- is still latex (`-t native` does not set FORMAT to latex, so the filters under test take
-- their non-latex branch and the structure never appears).
function Pandoc(doc)
  local out = {}
  for _, b in ipairs(doc.blocks) do
    local text = (b.t == 'RawBlock') and b.text or pandoc.utils.stringify(b)
    text = text:gsub('%s+', ' ')
    table.insert(out, b.t .. '|' .. text:sub(1, 300))
  end
  return pandoc.Pandoc({ pandoc.RawBlock(FORMAT, table.concat(out, '\n')) })
end
