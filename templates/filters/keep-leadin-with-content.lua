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
  if nxt.t == 'Header' then return 7 end
  -- A table's header row repeats at the top of each page (longtable). If the table starts
  -- so near a page foot that its first chunk is empty, the header prints at the top of the
  -- page AND again above the first row -- which is what put "Dimension / Key Metrics / What
  -- to Track" twice on p.229 with the intro paragraph between them.
  if nxt.t == 'Table' then return 10 end
  -- A callout becomes a tcolorbox: a boxed title, padding, and `lines before break=4`
  -- below it. Five lines is not enough to start one, so the box moved to the next page and
  -- left the lead-in behind -- which kept "For Stale Memory Banks...:" stranded on p.146
  -- after the Header and Figure cases were handled.
  --
  -- It arrives here as a RawBlock, not a Div: callout-filter-print.lua has already turned
  -- it into LaTeX by the time this filter runs. Probing with `-t native` shows a Div and is
  -- misleading, because that filter only converts when the target is LaTeX.
  if nxt.t == 'Div' then return 9 end
  if nxt.t == 'RawBlock' and nxt.format == 'latex'
     and nxt.text:match('\\begin%s*{') then return 9 end
  -- A list carries its own \topsep above the first item, so five lines leaves too little
  -- for the item itself: "Documenting gaps systematically:" stayed at the foot of p.80
  -- while its numbered list moved on. Eight covers the skip and a two or three line item.
  if nxt.t == 'OrderedList' or nxt.t == 'BulletList' or nxt.t == 'DefinitionList' then
    return 6
  end
  if nxt.t == 'Figure' then return nil end
  if (nxt.t == 'Para' or nxt.t == 'Plain') and #nxt.content == 1
     and nxt.content[1].t == 'Image' then return nil end
  return 5
end

-- Does a callout box come next?
--
-- callout-filter-print.lua emits a \FloatBarrier on each side of every callout, so that a
-- deferred figure can no longer be dropped between a box and its own footnote. placeins'
-- \FloatBarrier issues a \newpage when floats are actually held, and that break landed
-- BETWEEN the lead-in and the box it introduces: "For Stale Memory Banks ...:" sat at the
-- foot of p.156 while Figure 5.4 and the callout went to p.157. Issuing the barrier HERE,
-- ahead of the reservation, dumps the held float first, so the lead-in and its box are
-- placed together afterwards; the filter's own leading barrier is then a no-op.
--
-- Named classes rather than "any Div": a Div can be a crossref wrapper or a size switch,
-- and dumping floats in front of one of those would cost pages for nothing. These are the
-- fenced-div classes the callout filters recognise. A callout that has ALREADY been turned
-- into LaTeX (a pipeline that runs the callout filter first) arrives as a RawBlock instead.
local CALLOUT_CLASSES = { info = true, code = true, success = true, warning = true,
                          error = true, conversation = true, promptref = true }

local function callout_follows(blk)
  if blk.t == 'Div' and blk.classes then
    for _, class in ipairs(blk.classes) do
      if CALLOUT_CLASSES[class] then return true end
    end
    return false
  end
  if blk.t == 'RawBlock' and blk.format == 'latex' then
    return blk.text:match('\\begin%s*{tcolorbox}') ~= nil
  end
  return false
end

-- Does this block start with a table, looking through wrappers?
--
-- A table is not always a bare Table block: a Div (a crossref wrapper, a size switch, any
-- fenced div) can hold it, and a RawBlock can already be a longtable. Matching only
-- `t == 'Table'` would give a wrapped table the lazy \needspace and bring the ghost head
-- back. Only what comes FIRST inside a wrapper counts -- that is what sits directly under
-- the lead-in; a table further down a Div has other content between it and the lead-in.
local function starts_with_table(blk)
  if blk.t == 'Table' then return true end
  if blk.t == 'Div' then
    local first = blk.content[1]
    return first ~= nil and starts_with_table(first)
  end
  if blk.t == 'RawBlock' and blk.format == 'latex' then
    return blk.text:match('^%s*\\begin%s*{longtable}') ~= nil
  end
  return false
end

-- The EAGER reservation.
--
-- \needspace is LAZY: it lays down `\vskip 0pt plus N\baselineskip` and a -100 penalty and
-- lets TeX decide later. That stretch is what makes a near-empty page look cheap, and it
-- becomes visible as soon as the next legal breakpoint is a long way off -- which is exactly
-- what an unbreakable callout makes it. Measured: p.118 of the round-8 build carried three
-- lines and 90% white, shipped with badness 3861, because the only alternative break was
-- past a 290pt pinned box and scored 100000. \needspaceNow decides NOW instead: it emits
-- nothing at all when the space is there, so no stretch is left behind for TeX to exploit.
--
-- \needspaceNow lives in book-print.latex, so degrade to plain \needspace wherever it is
-- undefined: another template loses this, not its build.
local function reserve(amount)
  return '\\ifdefined\\needspaceNow\\needspaceNow' .. amount
      .. '\\else\\needspace' .. amount .. '\\fi'
end

function Blocks(blocks)
  local out = pandoc.List()
  for i, blk in ipairs(blocks) do
    local nxt = blocks[i + 1]
    -- Skip the reservation when a heading sits immediately before: titlesec already reserved
    -- space for that heading, and asking again here CHAINS the two. That is what left
    -- headings alone at the foot of a page with a large gap below -- the heading placed on
    -- its 7 reserved lines, then the lead-in demanded 8 more for its list, did not get them,
    -- and took the whole paragraph to the next page. p.130 was 12% full because of this.
    local after_heading = i > 1 and blocks[i - 1].t == 'Header'
    if nxt and not after_heading and ends_with_colon(blk) then
      local is_table = starts_with_table(nxt)
      -- A table, bare or behind a wrapper, reserves 10 lines. reservation_for would answer 9
      -- for a Div (the callout figure) and 5 for a raw block.
      local n = is_table and 10 or reservation_for(nxt)
      if n then
        local amount = '{' .. n .. '\\baselineskip}'
        if is_table then
          -- A table needs the EAGER form. \needspace is lazy, and in front of a longtable
          -- the break it defers is taken inside longtable's output routine, which copies the
          -- table head to the top of the next page AHEAD of this lead-in. See reserve()
          -- above and \needspaceNow in book-print.latex.
          out:insert(pandoc.RawBlock('latex', reserve(amount)))
        elseif callout_follows(nxt) then
          -- A callout takes the EAGER form too, for the reason given at reserve(): a pinned
          -- box puts the next legal breakpoint a whole box away, and the lazy form's stretch
          -- then buys a three-line page.
          -- The barrier comes first so that a held float is dumped BEFORE the reservation,
          -- not between the lead-in and the box it introduces (that is what left "For Stale
          -- Memory Banks ...:" at the foot of p.156 with Figure 5.4 and its callout
          -- overleaf). \ifdefined because book-builder is shared: a template without
          -- placeins loses the barrier, not the build.
          out:insert(pandoc.RawBlock('latex',
            '\\ifdefined\\FloatBarrier\\FloatBarrier\\fi' .. reserve(amount)))
        else
          out:insert(pandoc.RawBlock('latex', '\\needspace' .. amount))
        end
      end
    end
    out:insert(blk)
  end
  return out
end
