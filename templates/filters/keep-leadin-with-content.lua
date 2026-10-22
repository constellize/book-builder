-- Keep a lead-in line with what it introduces.
--
-- The publisher's proof review flagged "The book is organized as follows:" stranded at the
-- foot of p.32, away from the chapter list on p.33. Twelve such cases were measurable.
--
-- THREE THINGS THAT DO NOT WORK, all tried and measured:
--
--   \widowpenalty=10000      governs a break INSIDE a paragraph. This break is between two
--                            paragraphs. Cleared 3 of 12 by coincidence, not mechanism.
--   \@beginparpenalty=10000  governs a break before a LIST. Most of these lead-ins are
--                            followed by a callout box or an ordinary paragraph, not a list.
--                            Made it WORSE -- 9 to 10 -- and cost a page.
--   \nopagebreak as a block  pandoc emits it as its own block, so it lands AFTER the
--                            inter-paragraph glue: text \par [glue] \nopagebreak [glue] text.
--                            TeX simply breaks at the first glue. No effect.
--
-- What works is reserving the space BEFORE the lead-in: \needspace{N\baselineskip} starts a
-- new page if N lines will not fit, so the lead-in never begins near the foot of a page.
--
-- 5 lines: the lead-in itself plus roughly three of whatever follows. Enough to be clearly
-- attached without demanding so much that pages end up badly underfilled.

-- The colon is often INSIDE formatting: "**The book is organized as follows:**" makes the
-- paragraph's last inline a Strong, not a Str. Checking only for Str missed 6 of 12 cases,
-- including the one the publisher named. Descend through wrappers to the real last string.
local WRAPPERS = { Strong = true, Emph = true, Span = true, Link = true,
                   Underline = true, SmallCaps = true, Strikeout = true }

local function last_string(inlines)
  local last = inlines[#inlines]
  if not last then return nil end
  if last.t == 'Str' then return last.text end
  if WRAPPERS[last.t] and last.content then return last_string(last.content) end
  return nil
end

local function ends_with_colon(blk)
  if blk.t ~= 'Para' and blk.t ~= 'Plain' then return false end
  local text = last_string(blk.content)
  return text ~= nil and text:sub(-1) == ':'
end

-- How much to reserve depends on what follows:
--
--   a heading   LaTeX adds a large skip above a heading, so 5 lines is swallowed by glue
--               and the heading still moves. 10 covers the skip plus a few lines under it.
--   a figure    Reserve nothing. A float is placed by LaTeX's own algorithm, not by the
--               surrounding vertical list, so no reservation can hold it next to the lead-in.
--               Emitting one here only pushes the lead-in around for no benefit.
--   anything    5 lines: the lead-in plus roughly three of what follows.
local function reservation_for(nxt)
  if nxt.t == 'Header' then return 10 end
  -- A callout becomes a tcolorbox: a boxed title, padding, and `lines before break=4`
  -- below it. Five lines is not enough to start one, so the box moved to the next page and
  -- left the lead-in behind -- which kept "For Stale Memory Banks...:" stranded on p.146
  -- after the Header and Figure cases were handled.
  --
  -- It arrives here as a RawBlock, not a Div: callout-filter-print.lua has already turned
  -- it into LaTeX by the time this filter runs. Probing with `-t native` shows a Div and is
  -- misleading, because that filter only converts when the target is LaTeX.
  if nxt.t == 'Div' then return 12 end
  if nxt.t == 'RawBlock' and nxt.format == 'latex'
     and nxt.text:match('\\begin%s*{') then return 12 end
  -- A list carries its own \topsep above the first item, so five lines leaves too little
  -- for the item itself: "Documenting gaps systematically:" stayed at the foot of p.80
  -- while its numbered list moved on. Eight covers the skip and a two or three line item.
  if nxt.t == 'OrderedList' or nxt.t == 'BulletList' or nxt.t == 'DefinitionList' then
    return 8
  end
  if nxt.t == 'Figure' then return nil end
  if (nxt.t == 'Para' or nxt.t == 'Plain') and #nxt.content == 1
     and nxt.content[1].t == 'Image' then return nil end
  return 5
end

function Blocks(blocks)
  local out = pandoc.List()
  for i, blk in ipairs(blocks) do
    local nxt = blocks[i + 1]
    if nxt and ends_with_colon(blk) then
      local n = reservation_for(nxt)
      if n then
        out:insert(pandoc.RawBlock('latex', '\\needspace{' .. n .. '\\baselineskip}'))
      end
    end
    out:insert(blk)
  end
  return out
end
