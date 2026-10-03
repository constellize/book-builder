--[[
  Remove images, for the narration .docx.

  The publisher needs Word only for the audiobook: "clean readable text is all it has to
  be, images not required". Stripping them is also what makes the file sane -- the
  typesetter variants are ~54MB, almost entirely embedded artwork and fonts, which is
  awkward to email and pointless for someone reading aloud.

  Alt text is kept as a bracketed note rather than dropped. A narrator reading "Figure:
  the five steps of Constellize" knows a figure was there and can decide whether the
  surrounding prose needs it; silently deleting the image leaves a dangling "as shown
  below" with nothing below it.
--]]

function Image(el)
  local alt = pandoc.utils.stringify(el.caption or {})
  if alt == '' then
    for _, inline in ipairs(el.content or {}) do
      alt = alt .. pandoc.utils.stringify(inline)
    end
  end
  if alt == '' then return {} end
  return pandoc.Emph({ pandoc.Str('[Figure: ' .. alt .. ']') })
end

-- A paragraph that held only an image becomes an empty paragraph; drop it so the
-- narrator is not reading past blank blocks.
function Para(el)
  if #el.content == 0 then return {} end
  return el
end
