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

-- HOW MANY LINES THE LEAD-IN ITSELF WILL OCCUPY.
--
-- Every number in reservation_for() below was tuned against a ONE-LINE lead-in, and the
-- reservation is emitted BEFORE the lead-in, so it has to cover the lead-in *and* what
-- follows out of the same budget. A two-line lead-in therefore silently spends one of the
-- lines meant for the content: "These sketches help us think through:" is two lines, so its
-- 6-line list reservation left 4 for \topsep plus a bullet, the bullets did not fit, and the
-- lead-in sat alone at the foot of p.87 -- the publisher's class 4, in a chapter round 8
-- never touched. Round 7 had the same bug at p.161 ("other platform components:").
--
-- 70 characters per line is the full-measure body text figure, NOT the callout filter's
-- FIT.text_chars (50), which describes the narrower measure inside a box. Measured lines on
-- the 6x9 build run 66-75 characters depending on justification; 70 sits in the middle.
--
-- ERRING HIGH IS THE CORRECT DIRECTION HERE, and it is the opposite of the choice made for
-- the callout reservation in callout-filter-print.lua. There, over-reserving costs blank
-- paper and nothing else. Here, UNDER-reserving strands a lead-in, which is a fault the
-- publisher has named in two consecutive rounds. A line of whitespace is cheaper than that.
local BODY_CHARS = 70

local function leadin_lines(blk)
  local ok, text = pcall(pandoc.utils.stringify, blk)
  if not ok or type(text) ~= 'string' or text == '' then return 1 end
  local n = (utf8 and utf8.len and utf8.len(text)) or #text
  return math.max(1, math.ceil(n / BODY_CHARS))
end

-- A LEAD-IN THAT IS ITSELF A BOX.
--
-- `::: info` holding one colon-ending sentence, immediately followed by `::: code`, is a
-- lead-in whose content is in the NEXT box. Blocks() below cannot see it: the sentence is a
-- Para inside a Div, so its `nxt` sibling within that Div is nil, and at the outer level the
-- block is a Div rather than a colon-ending Para. Nothing matched, no reservation was
-- emitted, and "...connect with other platform components:" ended a page alone in round 7
-- (p.161) and again in round 8 (p.159) -- the one instance of the publisher's class 4 that
-- survived a whole round untouched because no rule was looking at it.
--
-- Two instances in this book, both in ch6. Fixed here rather than by unwrapping them in the
-- manuscript, so the shape stays available to the author and the next reflow cannot
-- reintroduce it.
local function ends_with_colon(blk)
  if blk.t ~= 'Para' and blk.t ~= 'Plain' then return false end
  local text = last_string(blk.content)
  return text ~= nil and text:sub(-1) == ':'
end

-- Declared AFTER ends_with_colon on purpose: a `local function` is not in scope inside a
-- function defined above it, so calling it from there would silently resolve to a nil global.
local function leadin_box(blk)
  if blk.t ~= 'Div' then return nil end
  local inner = nil
  for _, b in ipairs(blk.content or {}) do
    if b.t == 'Para' or b.t == 'Plain' then
      if inner then return nil end                 -- more than one paragraph: a real box
      inner = b
    elseif b.t ~= 'Null' then
      return nil                                   -- holds anything else: a real box
    end
  end
  if inner and ends_with_colon(inner) then return inner end
  return nil
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
  -- It arrives here as a DIV, not a RawBlock. This comment said the opposite until round 8
  -- and the opposite is false: pandoc-defaults-print.yaml:38-39 runs this filter BEFORE
  -- callout-filter-print.lua, on purpose, so that lead-ins inside a callout are still
  -- reachable. The RawBlock branch below is the fallback for a pipeline that orders them the
  -- other way round; on the book's own print path only the Div branch is ever taken. Check
  -- the defaults file before trusting either branch -- the wrong version of this comment sent
  -- two separate attempts at the pinned-box reservation into dead code. See the note on
  -- Blocks() below.
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

--[[
  NOT FIXED, and the reason is recorded here because it cost a round to find twice.

  A lead-in before a PINNED callout still strands: "Essential steps:" (p.95), "Key
  implementations:" (p.101), "Managing knowledge evolution:" (p.144). Nine baselines is the
  right reservation for a box that can SPLIT -- enough to start it, the rest flows over -- and
  the wrong one for a box that cannot. A pinned box needs its whole height; when it does not
  get it the box moves and the lead-in, already placed on its nine reserved lines, is left at
  the foot. Round 7 had none of these because nothing was pinned then. They are the cost of
  fixing class 2, and they are real: class 4 went from 2 true instances to 5.

  The obvious fix -- reserve the box's own height instead of nine lines -- CANNOT BE WRITTEN
  HERE. The height exists: callout-filter-print.lua writes it into the stream as
  `%%CALLOUTFIT ... pinned=1 est=355.76 ...`. But that filter runs AFTER this one
  (pandoc-defaults-print.yaml:38-39, deliberately, so lead-ins inside callouts are still
  reachable as blocks), so when this filter looks at the next block it is a Div and no
  estimate exists yet. A `pinned_box_height()` reading that comment was written, measured and
  deleted: it is unreachable on the only pipeline that loads this filter.

  Where the fix belongs is callout-filter-print.lua, which knows the height at the moment it
  pins: in its Blocks handler, rewrite the preceding `\needspace...{9\baselineskip}` this
  filter emitted to the box's measured height. That is a change to the other filter, not this
  one, and it was not taken in round 8.
--]]

function Blocks(blocks)
  local out = pandoc.List()
  for i, blk in ipairs(blocks) do
    local nxt = blocks[i + 1]
    -- A lead-in sitting immediately under a heading gets NO reservation of its own, and the
    -- reason changed in round 8. It used to be chaining: titlesec reserved space for the
    -- heading, the lead-in asked again, and the heading was left alone above a large gap
    -- (p.130 was 12% full). Those heading reservations are now off -- book-print.latex
    -- defines \sectionbreak and friends as empty -- so chaining can no longer happen.
    --
    -- The guard stays because the other hazard is worse and does NOT depend on that switch:
    -- this reservation is emitted AFTER the heading, so when it forces a break the heading
    -- stays behind on the old page by itself. That is the publisher's class 3, the stranded
    -- "Day 1: Create Your First Memory Bank" on p.237 of round 7 -- trading class 4 for a
    -- fault they complained about more loudly.
    --
    -- MOVING THE RESERVATION ABOVE THE HEADING WAS TRIED, MEASURED AND REJECTED. Do not
    -- rebuild it without reading this.
    --
    -- The shape it targets is real: "3.4.1 Planning Implementation Approaches" / "These
    -- sketches help us think through:" / bulleted list left the lead-in alone at the foot of
    -- p.89, and it is the one shape no other rule here can reach, because this guard
    -- suppresses the reservation and the lead-in has nothing in front of it to push.
    --
    -- The implementation worked exactly as intended -- reserve heading skip + heading lines +
    -- lead-in lines + content from ABOVE the heading, eager, at the fourteen sites in the
    -- manuscript where a heading is directly followed by a colon lead-in. p.89 closed, class
    -- 4 went to 2 (both detector false positives), and it cost no pages at all.
    --
    -- It was still reverted, because of what the reflow did two chapters away: ch6 moved far
    -- enough that the promptref box on p.177 ended flush with the page foot and its footnote
    -- URL was left alone at the head of p.178. That is class 2, and class 2 is the shape the
    -- publisher named FIRST -- a stranded prompt-reference URL on p.215 of round 7. Trading a
    -- lead-in strand they never flagged for a detached footnote they did is a worse book and
    -- a worse answer to their review, at one genuine fault either way.
    --
    -- Narrowing the reservation did not help: it double-counted the lead-in line (see the
    -- bare-lead-in branch, which spends (leadin_lines - 1) for the same reason), and
    -- correcting that to drop a baseline left p.178 exactly where it was.
    --
    -- The p.178 fault itself cannot be fixed from this filter. It needs the box's last line
    -- kept away from the page foot, and the only levers are reserving the whole box height
    -- before every promptref box -- which stops breakable boxes splitting, i.e. pins them,
    -- i.e. walks back into the 123-pinned sparse-page cliff -- or making the footnote part of
    -- the box content, which is a design change to callout-filter-print.lua.
    local after_heading = i > 1 and blocks[i - 1].t == 'Header'
    -- A one-sentence `::: info` introducing the box that follows it. The reservation has to
    -- cover the INFO BOX ITSELF -- its own lines plus frame and padding -- on top of what the
    -- following box needs, because the whole point is that the two are placed together.
    -- 50 characters per line, not BODY_CHARS: this text is inside a box, at the narrower
    -- measure the callout filter calls FIT.text_chars. Plus 2 for the frame and padding.
    local box_leadin = (not after_heading) and nxt and leadin_box(blk) or nil
    if box_leadin and callout_follows(nxt) then
      local text = pandoc.utils.stringify(box_leadin)
      local n = (utf8 and utf8.len and utf8.len(text)) or #text
      local own = math.max(1, math.ceil(n / 50)) + 2
      out:insert(pandoc.RawBlock('latex',
        '\\ifdefined\\FloatBarrier\\FloatBarrier\\fi'
        .. reserve('{' .. (9 + own) .. '\\baselineskip}')))
    elseif nxt and not after_heading and ends_with_colon(blk) then
      local is_table = starts_with_table(nxt)
      -- A table, bare or behind a wrapper, reserves 10 lines. reservation_for would answer 9
      -- for a Div (the callout figure) and 5 for a raw block.
      local n = is_table and 10 or reservation_for(nxt)
      if n then
        -- Pay for the lead-in's own lines on top of the tuned figure, which assumed one.
        -- See leadin_lines() for the p.87 / p.161 strands this closes.
        n = n + (leadin_lines(blk) - 1)
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
          -- EAGER here too, since round 8's second pass. This was the lazy \needspace, and
          -- while heading reservations were in force that was enough: a lead-in that lost its
          -- deferred break usually found one at the heading above. With those reservations
          -- gone (see \headingReserve in book-print.latex) the lazy form stopped holding, and
          -- "Essential steps:", "Key implementations:" and "Managing knowledge evolution:"
          -- each ended a page alone -- the publisher's class 4, 2 real instances -> 5.
          --
          -- Lazy means TeX may decline the break and keep the stretch glue; eager decides at
          -- the reservation. The trade is the one measured for tables and callouts above, now
          -- applied to the plain case: it can force a slightly shorter page rather than strand
          -- the lead-in, which is the way round this fault is meant to fall.
          out:insert(pandoc.RawBlock('latex', reserve(amount)))
        end
      end
    end
    out:insert(blk)
  end
  return out
end
