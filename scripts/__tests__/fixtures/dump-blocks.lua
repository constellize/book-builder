-- Test probe. Runs AFTER another filter and replaces the document with one line per
-- top-level block: "<Type>|<first 80 characters of its text, whitespace squeezed>".
--
-- It exists so a test can assert on the BLOCK STRUCTURE a filter produced while the writer
-- is still latex (`-t native` does not set FORMAT to latex, so the filters under test take
-- their non-latex branch and the structure never appears).
function Pandoc(doc)
  local out = {}
  for _, b in ipairs(doc.blocks) do
    local text = (b.t == 'RawBlock') and b.text or pandoc.utils.stringify(b)
    text = text:gsub('%s+', ' ')
    table.insert(out, b.t .. '|' .. text:sub(1, 80))
  end
  return pandoc.Pandoc({ pandoc.RawBlock(FORMAT, table.concat(out, '\n')) })
end
