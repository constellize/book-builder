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

-- ============================================================================
-- FLOAT BARRIERS AND PINNING  (publisher review 2026-11-02, items 1 and 2)
-- ============================================================================
--
-- ITEM 1: a figure landed between a callout and its own footnote (p.214->215 of round 7).
-- The template already asks for `\floatplacement{figure}{!ht}` and loads placeins with
-- [section], but `!ht` is only a preference -- a figure that does not fit is still deferred
-- and dropped at the top of a later page -- and placeins' [section] barrier only fires at
-- \section. The figure at ch8.md:186 and the callout at ch8.md:188 are in the SAME section,
-- so nothing stood between them. A \FloatBarrier on each side of every box does.
--
-- ITEM 2: a callout shed an orphaned tail -- five instances in round 7 (pp. 80, 105, 108,
-- 112, 141), four of them a promptref box whose footnote URL ended up alone overleaf.
--
-- WHY PINNING, AND NOT PENALTIES. Both of these were measured, not guessed:
--   * tcolorbox's splitting IGNORES PENALTIES IN BOX CONTENT. An explicit \penalty10000 at
--     the observed break point changed nothing. So \widowpenalty, \brokenpenalty and
--     fancyvrb's own last-line widow penalty are all inert inside a callout.
--   * There is NO `lines after break` key. `lines before break` (set in book-print.latex)
--     governs only the part BEFORE a split, which is why the publisher's suggested
--     "minimum lines after a break" rule does not exist and cannot be built.
-- The tail is therefore prevented by NOT SPLITTING a box that could have fitted whole.
-- A promptref's footnote is set INSIDE its own box (tcolorbox collects it at the box foot),
-- which is why an unbreakable box keeps the footnote with the Link: line it belongs to.
--
-- WHY THE THRESHOLD IS CONSERVATIVE. A pinned box that does not fit the text block does NOT
-- degrade into an Overfull \vbox: xelatex SPINS FOREVER shipping empty pages. Measured at
-- the 6x9 trim with this template: a pinned code callout of 35 rendered lines (~544pt)
-- typesets; 36 (~558pt) never terminates. So the estimate below must never be allowed to
-- run high, and anything it cannot measure confidently is left breakable.
--
-- THE GEOMETRY THESE NUMBERS DESCRIBE. Every constant below is in TeX points and was
-- measured against ONE page geometry:
--
--     trim 6x9in        \usepackage[paperwidth=6in,paperheight=9in,
--     margins            inner=0.75in,outer=0.5in,top=0.75in,bottom=0.75in]{geometry}
--     \textheight       542.03pt
--     body              11pt at linestretch 1.2
--     code              \setminted{fontsize=\small}
--
-- book-builder is SHARED. A consuming book that uses these print defaults with its own
-- template -- A5, 10pt, tighter leading -- has a different text block, and none of these
-- numbers describes it. Pinning a box against a 433pt budget on a shorter page does not
-- warn and does not overfull: it HANGS xelatex (see THE CLIFF above). So pinning is
-- OPT-IN, declared by the template; see PIN_BUDGET below. The filter never reads
-- \textheight itself -- a Lua filter runs before TeX exists.
--
-- The derivation of each constant is recorded in book-builder/memory-bank/systemPatterns.md
-- and re-derivable with scripts/__tests__/fixtures/fit-probe.tex; keep all three in step.
local FIT = {
  text_block  = 542.03, -- \textheight of the CALIBRATED geometry above (not of this build)
  fraction    = 0.80,   -- of the text block a pinned box may claim. The missing 20% covers
                        -- estimation error, because overrunning does not cost a warning --
                        -- it costs the build. The tallest box this book pins measures 429pt.

  box         = 34.00,  -- frame + a one-line boxed title + top=0.75em + bottom=0.5em
  title_line  = 19.65,  -- each FURTHER line a wrapped boxed title takes.
                        --
                        -- MEASURED, and it was 18.00 until 2026-11-02. The probe isolates it
                        -- as (title-83 - title-11) - text_line = 35.97 - 16.32 = 19.65: a
                        -- promptref repeats its title in its own `Link:` line, so the raw
                        -- difference between two title lengths moves TWO things and one body
                        -- line has to be backed out of it. 18.00 was 1.65pt LOW per wrapped
                        -- title line, which is the direction that pins a box that does not
                        -- fit and hangs the build.
                        --
                        -- IT IS NOT LINEAR, and 19.65 is the UPPER of the two measured steps.
                        -- The 1->2 step costs 19.65; the 2->3 step costs only 13.03
                        -- ((title-120 - title-83) - text_line = 29.35 - 16.32), because the
                        -- attached boxed title is laid over the box's own top padding and the
                        -- first extra line eats room the later ones have to find. Using the
                        -- larger figure for every line over-estimates a 3-line title by
                        -- 6.6pt, which is the safe direction; using 13.03 would under-estimate
                        -- a 2-line one by 6.6pt, which is not. No title in this book reaches
                        -- 3 lines.
  title_chars = 42,     -- characters per line of the boxed title (small, 0.82\linewidth)

  text_line   = 16.32,  -- one line of body text: 11pt at linestretch 1.2
  text_chars  = 50,     -- characters per line inside a box (58 measured; held back for
                        -- justification and for bold or italic runs that set wider)

  code_line   = 14.40,  -- one rendered line of minted at \setminted fontsize=\small
  code_chars  = 48,     -- characters on the FIRST rendered line of a code line. The geometric
                        -- measure takes 56, but breaklines/breakanywhere break at the last
                        -- break point BEFORE the measure and indent the continuation under
                        -- the hook symbol, so a wrapped line really gets about 48.
                        --
                        -- A CONTINUATION LINE GETS FEWER THAN THIS -- see wrapped_code().
  code_tab    = 8,      -- columns a leading tab occupies: fvextra's `tabsize` default, which
                        -- \setminted does not override. Only reached by a tab-indented
                        -- source; this book has none anywhere.
  code_pad    =  6.30,  -- fancyvrb's own space above and below a minted block

  note_base   = 10.19,  -- footnote rule and \skip\footins inside the box.
                        --
                        -- MEASURED 10.19, and it was 10.00 until 2026-11-02. A rounded-down
                        -- constant is still a constant that runs LOW, which is the direction
                        -- that pins a box that does not fit; the 0.19pt is kept for the same
                        -- reason title_line's 1.65pt was.
  note_line   = 11.00,  -- one line of footnote text
  note_chars  = 40,

  em          = 11.00,  -- 1em of the body font, for the \vspace the promptref box adds
}
FIT.calibrated_budget = FIT.fraction * FIT.text_block -- 433.6pt
--
-- Budget in whole lines, for reading the numbers above against a page:
--   a code callout  (433.6 - 34 - 6.3) / 14.40 = 27 rendered lines
--   a text callout  (433.6 - 34)       / 16.32 = 24 rendered lines
--
-- PIN_BUDGET: the tallest estimate that may be pinned, in points, or nil for "pin nothing".
--
-- It is OFF until the TEMPLATE declares it. book-print.latex defines
-- `\newcommand{\calloutPinBudget}{433.6}`; build-book.js reads that definition out of
-- whatever template book.config.js names for the target and forwards the number to pandoc as
-- `--metadata=callout-pin-budget:433.6`, which the Meta pass below picks up. A template that
-- does not define the macro gets no metadata, so this stays nil and every callout comes back
-- `breakable` -- correct, a few more split boxes, and no hangs.
--
-- Same convention as this round's two other shared-system changes (`\ifdefined\FloatBarrier`
-- and `\ifdefined\needspaceNow`): the capability is declared where the capability lives, and
-- its absence costs a feature rather than the build. The difference is the failure mode, which
-- is why this one is a hard gate and not a fallback.
local PIN_BUDGET = nil

-- No trade trim has a text block anywhere near this tall (US Letter's is 626pt). A larger
-- declared budget is a units mistake (mm? bp? \textheight of a slide?), not a taller book,
-- and honouring it would pin boxes past the cliff.
local MAX_SANE_PIN_BUDGET = 1000

-- Read on the Meta pass, which runs BEFORE the Div pass (this file returns the two filter
-- sets in that order). An unusable declaration is reported and ignored: pinning off is the
-- pre-round-8 behaviour and cannot hang anything.
local function readPinBudget(meta)
  local declared = meta and meta['callout-pin-budget']
  if declared == nil then
    if FORMAT and FORMAT:match('latex') then
      io.stderr:write('callout-filter-print: callout pinning is OFF -- no `callout-pin-budget` ' ..
        'metadata, so this template does not declare one (book-print.latex does it with ' ..
        '\\calloutPinBudget). Every callout stays breakable; boxes may split and shed a tail.\n')
    end
    return
  end
  local n = tonumber(pandoc.utils.stringify(declared))
  if not n or n <= 0 or n > MAX_SANE_PIN_BUDGET then
    io.stderr:write('callout-filter-print: ignoring callout-pin-budget "' ..
      tostring(pandoc.utils.stringify(declared)) .. '" (want a number of points in (0, ' ..
      tostring(MAX_SANE_PIN_BUDGET) .. ']). Pinning stays OFF.\n')
    return
  end
  PIN_BUDGET = n
end

-- The promptref titles this book pins, from book.config.js via --metadata.
--
-- A promptref's tail is a `Link:` line and its footnote, degenerate by construction, so when
-- one splits there the next page opens on a rule and a bare URL (round 7, p215). Pinning
-- EVERY promptref closed that and cost 16 pages, most of them out of chapter 4. These are the
-- ones that actually orphan; see the note in book.config.js for how the list was arrived at
-- and why it has to be re-derived when the text moves.
PIN_TITLES = {}
PIN_TITLES_SEEN = {}

local function readPinTitles(meta)
  local declared = meta and meta['callout-pin-titles']
  if declared == nil then return end
  for title in (pandoc.utils.stringify(declared) .. ';'):gmatch('(.-);') do
    title = title:gsub('^%s*(.-)%s*$', '%1')
    if title ~= '' then PIN_TITLES[title] = true end
  end
end

-- MEASURED BOX HEIGHTS, from the pre-flight pass. ------------------------------------------
--
-- build-book.js already runs pandoc twice: once to emit preflight.tex, which
-- check-pinned-callouts.js measures box by box under real xelatex, and once to build the PDF.
-- Until now the second run learned nothing from the first, so the lead-in reservation had to
-- work from estimate_blocks(), which is deliberately conservative and runs ~15% high on a
-- promptref. That padding is not free: it is the sole reason two callouts totalling 538.6pt
-- sat on separate pages of a 542pt text block (p.102/p.103 of the 256-page build), and it
-- cost a page every time it happened.
--
-- The pre-flight now hands those measurements back as `callout-measured-heights`, a
-- `idx:height` list. A measured height is the box under the real preamble at the real width,
-- so the reservation stops guessing. The height does NOT depend on the reservation -- a box's
-- height is set by its content and column width, not by where the page breaks -- so there is
-- no feedback loop and no second measuring pass is needed.
--
-- MEASURED HEIGHTS NEVER WIDEN THE PIN DECISION. calloutFitsOnePage() keeps the raw estimate:
-- under-estimating THERE pins a box that does not fit and hangs xelatex (see THE CLIFF), and
-- a measurement taken from a previous run must never be what unlocks a pin. This map is read
-- only by the reservation, where being wrong costs blank paper and nothing else.
local MEASURED_HEIGHTS = {}

local function readMeasuredHeights(meta)
  local declared = meta and meta['callout-measured-heights']
  if declared == nil then return end
  for pair in (pandoc.utils.stringify(declared) .. ';'):gmatch('(.-);') do
    local idx, pt = pair:match('^%s*(%d+)%s*:%s*([%d%.]+)%s*$')
    idx, pt = tonumber(idx), tonumber(pt)
    -- A non-positive or absurd height means the pre-flight parsed something it should not
    -- have; drop it and let that box fall back to the estimate rather than reserve nonsense.
    if idx and pt and pt > 0 and pt < 2000 then MEASURED_HEIGHTS[idx] = pt end
  end
end

-- Announce any title that matched no callout. A list that silently matches nothing is the
-- failure this whole round kept hitting: a guard that reports success while measuring nothing.
-- Written to stderr rather than raised, because a stale entry must not stop a build -- but it
-- must not pass unseen either, since the boxes it was holding are now unpinned.
local function reportUnmatchedPinTitles()
  local missing = {}
  for title in pairs(PIN_TITLES) do
    if not PIN_TITLES_SEEN[title] then missing[#missing + 1] = title end
  end
  if #missing > 0 then
    table.sort(missing)
    io.stderr:write('callout-filter-print: ' .. #missing .. ' calloutPinTitles entr(y/ies) ' ..
      'matched no callout in this book, so nothing was pinned for them. Check book.config.js ' ..
      'against the manuscript:\n')
    for _, t in ipairs(missing) do io.stderr:write('  - ' .. t .. '\n') end
  end
end
-- ============================================================================

local function charcount(s)
  if type(s) ~= 'string' then return 0 end
  return (utf8 and utf8.len and utf8.len(s)) or #s
end

-- How many typeset lines a string of plain text occupies at `per_line` characters.
local function wrapped(s, per_line)
  local n = charcount(s)
  if n <= 0 then return 1 end
  return math.ceil(n / per_line)
end

-- How many RENDERED lines one SOURCE line of minted code occupies.
--
-- NOT wrapped(). minted/fvextra's `breakautoindent` is on by default and `\setminted` in
-- book-print.latex does not turn it off, so every CONTINUATION line is indented under the
-- leading whitespace of the source line it came from. A continuation therefore holds
-- `per_line - indent` characters, not `per_line`:
--
--     a 96-character line indented 8 spaces sets in THREE lines, not two --
--     48 on the first, then 48 characters of remainder into continuations of 48-8 = 40.
--
-- WHY THIS IS NOT A ROUNDING NICETY. wrapped() under-counted exactly that line, and
-- under-counting is the dangerous direction: a low estimate pins a box, and a pinned box
-- that does not fit HANGS xelatex (see THE CLIFF above). It was the largest estimator drift
-- in the book -- the pre-flight measured a code callout at 383.82pt against its 371.50pt
-- estimate, +12.32pt, which is one rendered code line (14.40pt) of precisely this shape.
--
-- Correcting it makes code estimates RISE, so FEWER boxes qualify to be pinned at the same
-- budget. That is the right direction and it is not free: see the round-8 task-10 report.
local function wrapped_code(s, per_line)
  local n = charcount(s)
  if n <= 0 then return 1 end
  if n <= per_line then return 1 end
  -- Leading whitespace in COLUMNS. A tab counts as fvextra's tabsize rather than as one
  -- character, because the estimate has to describe the rendered line and not the source
  -- byte count; counting it as one would understate the indent, which understates the
  -- height, which is the unsafe direction.
  local ws = s:match('^[ \t]*') or ''
  local indent = charcount(ws) + (FIT.code_tab - 1) * select(2, ws:gsub('\t', ''))
  -- An indent as wide as the measure would leave a continuation no room at all. Clamp so
  -- the arithmetic stays finite; nothing in this book comes within 30 columns of it.
  local continuation = math.max(1, per_line - indent)
  return 1 + math.ceil((n - per_line) / continuation)
end

-- Walk a block for inlines that change the measurement:
--   an Image      the box's height is the image's, which this filter cannot know
--   a RawInline   arbitrary LaTeX: `\vspace{20cm}`{=latex} is 20cm of height and no text
--   a Note        a footnote, set at the foot of the box, so its height counts
--   a LineBreak   a hard break; the caller has to place it, so it is counted here only to
--                 check that the caller found every one of them
-- Returns extra height in points and the number of LineBreaks anywhere in the block, or nil
-- when the block cannot be measured at all.
--
-- EVERY branch of estimate_block() that measures running text must come through here. A
-- branch that walks inlines itself sees no Image and no Note, and silently pins a box around
-- a half-page diagram.
--
-- THE SHARED BLIND SPOT, and the reason two of the three breaches found so far were the same
-- bug: pandoc.utils.stringify() returns "" for a Note and "" for a RawInline. It is a
-- plain-text flattener and those two carry no plain text. So anything that reaches for the
-- height of a footnote, or for the width of a raw inline, by stringifying the element that
-- CONTAINS it measures zero and is silently short. A footnote's text is reached through
-- `note.content`; a raw inline's height cannot be reached at all, so it is unmeasurable.
local function inline_extras(blk)
  if not (pandoc.walk_block and pandoc.utils and pandoc.utils.stringify) then
    return nil -- an older pandoc: measure nothing rather than measure wrongly
  end
  local extra, breaks, measurable = 0, 0, true
  pandoc.walk_block(blk, {
    Image = function() measurable = false end,
    -- A RawInline's height is whatever the LaTeX does. `\vspace{20cm}`{=latex} inside a
    -- callout measured as zero characters and the box was pinned, which is the Image case
    -- again with a different element. Unmeasurable, same as an Image.
    RawInline = function() measurable = false end,
    LineBreak = function() breaks = breaks + 1 end,
    Note = function(note)
      -- note.content, NOT the Note: pandoc applies deNote in stringify, so
      -- stringify(note) is "" for every footnote ever written and every one of them
      -- costed exactly note_base + 2 note_lines = 32pt. A 15-line footnote was
      -- under-measured by ~130pt against 108pt of total headroom.
      local text = pandoc.utils.stringify(note.content)
      extra = extra + FIT.note_base
             + FIT.note_line * math.max(2, wrapped(text, FIT.note_chars))
    end,
  })
  if not measurable then return nil end
  return extra, breaks
end

-- Rendered lines of one flat inline list, splitting at HARD line breaks.
--
-- pandoc.utils.stringify() flattens a LineBreak to a space, so a paragraph written with
-- trailing-double-space breaks (the `escaped_line_breaks` extension, which the print
-- defaults enable, and which the manuscript already uses) measures as one long wrapped run
-- while the renderer sets one line per break. Forty-one hard-broken lines estimate at about
-- a third of their true height that way -- past the cliff, which is a build that never ends.
--
-- Returns the line count and how many LineBreaks it placed. The caller compares that second
-- number with inline_extras()'s total: a LineBreak nested inside Strong, a Link, a Span or a
-- footnote is one this loop cannot see, and the honest answer there is "do not pin". That
-- also makes a hard break inside a footnote unmeasurable, which is stricter than it needs to
-- be and is the right way round.
--
-- NOTE TEXT IS DELIBERATELY NOT COUNTED HERE. stringify() drops a Note's body (see
-- inline_extras()), and that is the behaviour this function wants: a footnote is not set in
-- the running text, it is set at the foot of the box, and inline_extras() costs it there with
-- note_base/note_line. Counting it in both places would double it. Only the marker is lost,
-- which is a superscript digit or two. The same flattening hides a RawInline's text, and that
-- one is NOT harmless -- inline_extras() answers "unmeasurable" for it, so no box containing
-- one ever reaches this line count.
local function lines_of_inlines(inlines)
  local lines, placed, parts = 0, 0, {}
  local function flush()
    lines = lines + wrapped(table.concat(parts), FIT.text_chars)
    parts = {}
  end
  for _, inline in ipairs(inlines) do
    if inline.t == 'LineBreak' then
      flush()
      placed = placed + 1
    else
      table.insert(parts, pandoc.utils.stringify(inline))
    end
  end
  flush()
  return lines, placed
end

local estimate_blocks -- forward declaration: block kinds recurse through it

-- Height of one block in points, or nil when it cannot be measured confidently. Returning
-- nil is always safe: the caller then leaves the box breakable, which is today's behaviour.
local function estimate_block(blk)
  local t = blk.t

  if t == 'Para' or t == 'Plain' then
    local extra, breaks = inline_extras(blk)
    if not extra then return nil end
    local lines, placed = lines_of_inlines(blk.content)
    if placed ~= breaks then return nil end -- a hard break this filter cannot place
    return FIT.text_line * lines + extra

  elseif t == 'LineBlock' then
    -- A line block is a list of inline lists, one per line. It MUST go through
    -- inline_extras() like any other running text: before it did, a line block holding a
    -- half-page diagram measured at about 66pt and was pinned, and a footnote in one was
    -- not counted at all.
    local extra, breaks = inline_extras(blk)
    if not extra then return nil end
    local h, placed = 0, 0
    for _, line in ipairs(blk.content) do
      local lines, n = lines_of_inlines(line)
      h = h + FIT.text_line * lines
      placed = placed + n
    end
    if placed ~= breaks then return nil end
    return h + extra

  elseif t == 'CodeBlock' then
    -- Only reached when this filter runs before minted-filter.lua; in the print pipeline
    -- minted-filter has already turned code blocks into RawBlocks, handled below.
    local h = FIT.code_pad
    for line in (blk.text .. '\n'):gmatch('(.-)\n') do
      h = h + FIT.code_line * wrapped_code(line, FIT.code_chars)
    end
    return h

  elseif t == 'RawBlock' then
    if blk.format ~= 'latex' and blk.format ~= 'tex' then return nil end
    local body = blk.text:match('\\begin{minted}%b{}\n(.-)\n\\end{minted}')
    if body then
      local h = FIT.code_pad
      for line in (body .. '\n'):gmatch('(.-)\n') do
        h = h + FIT.code_line * wrapped_code(line, FIT.code_chars)
      end
      return h
    end
    if blk.text:match('^%s*$') then return 0 end
    return nil -- some other piece of LaTeX: unknown height

  elseif t == 'BulletList' or t == 'OrderedList' then
    -- One extra line for \topsep above the list; the items themselves measure as text,
    -- which a measurement of \tightlist showed to be slightly generous per item.
    local h = FIT.text_line
    for _, item in ipairs(blk.content) do
      local ih = estimate_blocks(item)
      if not ih then return nil end
      h = h + ih
    end
    return h

  elseif t == 'BlockQuote' then
    local h = estimate_blocks(blk.content)
    if not h then return nil end
    return h + FIT.text_line

  elseif t == 'Div' then
    return estimate_blocks(blk.content)

  elseif t == 'HorizontalRule' then
    return FIT.text_line
  end

  -- Header (unbounded \@startsection skips), Table (longtable, which cannot be pinned at
  -- all), Figure, DefinitionList and anything a later pandoc adds: not measured.
  return nil
end

--[[
  KNOWN INTERACTION, not fixed (round 8): a callout that contains its OWN lead-in can never
  be pinned.

  keep-leadin-with-content.lua runs BEFORE this filter in pandoc-defaults-print.yaml, and
  deliberately so: callouts are still Divs at that point, so the filter walks into them and
  protects lead-ins INSIDE a box as well as outside. It does that by inserting a
  `\needspace{N\baselineskip}` RawBlock into the Div's own content. By the time
  estimate_block() sees that block it is a LaTeX RawBlock that is not a minted environment
  and is not blank, so it answers nil, and the whole box is left breakable.

  That fails SAFE -- an unpinned box is exactly today's behaviour, and nothing overruns. But
  it means fault B (an orphaned tail) can quietly come back for any callout that gains a
  sentence ending in a colon, with no warning and no test failure. There is nothing in the
  rendered page to tell you why that one box behaved differently from its neighbours.

  Fixing it means recognising the sibling filter's reservation here and costing it as
  N\baselineskip, which couples the two filters more tightly than this round wanted to. If
  you do, note that a reservation is LAZY glue, so the honest cost is somewhere between 0
  and N lines depending on where the box lands -- count N and stay conservative.
--]]

estimate_blocks = function(blocks)
  local h = 0
  for _, blk in ipairs(blocks) do
    local bh = estimate_block(blk)
    if not bh then return nil end
    h = h + bh
  end
  return h
end

-- Can this callout be set as ONE unbreakable box on a page of its own?
--
-- `extras` is optional: { title = <boxed title text>, extra_height = <points> }. The title
-- matters because a long promptref name wraps the boxed title over two or three lines.
--
-- Interface note for the sibling filters: this answers only "does it fit", never "should it
-- be pinned". generateConversationCallout deliberately does not ask -- see there.
-- Returns `fits`, and the ESTIMATE IN POINTS as a second value (nil when the box could not
-- be measured at all, or when no budget is declared). The estimate is second because every
-- existing caller wants only the boolean; it is returned at all because
-- scripts/check-pinned-callouts.js cross-checks each pinned box's estimate against its real
-- measured height, and the only place that number exists is here. See emitFitProvenance().
function calloutFitsOnePage(contentBlocks, extras)
  -- No template-declared budget, no pinning. This is the I-1 gate: the FIT constants
  -- describe one page geometry and the filter cannot tell which one it is rendering onto.
  if not PIN_BUDGET then return false, nil end
  extras = extras or {}
  local h = estimate_blocks(contentBlocks)
  if not h then return false, nil end

  h = h + FIT.box + (extras.extra_height or 0)
  if extras.title then
    h = h + FIT.title_line * (wrapped(extras.title, FIT.title_chars) - 1)
  end
  return h <= PIN_BUDGET, h
end

-- Does this callout END in a tail that would be stranded if the box split there?
--
-- WHY THIS EXISTS, and why it replaced "pin everything that fits" (round 8, second pass).
--
-- Pinning every box that happened to FIT a page pinned 123 of 157 callouts and cost the book
-- ten pages and seventeen and a half pages' worth of whitespace -- a pinned box that does not
-- fit where it stands moves to the next page and leaves its hole behind. Measured against the
-- round-7 build, mean page fill went 78.8% -> 73.1% and pages at 90%+ fill went 139 -> 101.
--
-- Fit is the WRONG question. It asks "may this box be pinned", not "does this box need to
-- be". A callout that splits mid-prose across a page turn costs nothing and the book did it
-- happily for seven rounds. What was reported was narrower: a box splitting so that the page
-- opens on a tail carrying no information -- p80's `] } } } }`, five structural closers alone
-- at the head of a page, from the JSON sample in `ch3.md:60`.
--
-- So pin on the tail, not the fit. Six callouts in the book end in a closer run; those are
-- the ones that can strand something degenerate, and those are the ones pinned.
--
-- FIT IS STILL REQUIRED. The caller must combine this with calloutFitsOnePage(): a box that
-- needs pinning but does not fit the text block HANGS xelatex (see FIT above), so it stays
-- breakable and the pre-flight check reports it. Needing a pin never earns one.
--
-- NOT ASKED FOR PROMPTREFS, and that is not an oversight. A promptref's tail is a `Link:`
-- line and its footnote, which is degenerate by construction and was four of the five
-- class-2 instances; those boxes pin on fit alone at their own call site. This test is for
-- the boxes whose tail is only knowable by looking -- `::: code`, `::: info` and the rest.
local CLOSER_ONLY = '^[%s%]%}%)]*[%]%}%)][%s%]%}%),;]*$'

local function code_text_of(blk)
  -- Pre-minted (this filter running first) and post-minted (the print pipeline) both occur;
  -- estimate_block() handles the same two shapes for the same reason.
  if blk.t == 'CodeBlock' then return blk.text end
  if blk.t == 'RawBlock' and (blk.format == 'latex' or blk.format == 'tex') then
    return blk.text:match('\\begin{minted}%b{}\n(.-)\n\\end{minted}')
  end
  return nil
end

local function tailWouldStrand(blocks)
  for _, blk in ipairs(blocks) do
    local code = code_text_of(blk)
    if code then
      -- A closer-only LAST line means the block ends in a tail carrying nothing a reader can
      -- use; one such line is enough, because one `}` alone at the head of a page is the same
      -- fault as p80's five. Blank lines are skipped so trailing newlines do not mask it.
      -- ANY code block in the box counts, not just the last one -- a box with two blocks can
      -- split so that the first block's tail opens a page.
      local last = nil
      for line in (code .. '\n'):gmatch('(.-)\n') do
        if line:match('%S') then last = line end
      end
      if last and last:match(CLOSER_ONLY) then return true end
    elseif blk.t == 'Div' or blk.t == 'BlockQuote' then
      if tailWouldStrand(blk.content) then return true end
    elseif blk.t == 'BulletList' or blk.t == 'OrderedList' then
      for _, item in ipairs(blk.content) do
        if tailWouldStrand(item) then return true end
      end
    end
  end
  return false
end

-- A callout and its two float barriers travel in ONE RawBlock.
--
-- keep-leadin-with-content.lua recognises a callout either as a Div (the print pipeline runs
-- it before this filter) or as a LaTeX RawBlock containing `\begin{`, and reserves nine
-- lines for it rather than the generic five. A barrier emitted as its own block would be
-- what that filter sees in a pipeline that runs the two the other way round, dropping the
-- callout to five lines and re-stranding the lead-ins rounds 5 and 6 closed.
--
-- \ifdefined guards the macro because book-builder is shared: a template that does not load
-- placeins loses the barrier, not the build.
local function barriered(latex)
  local barrier = '\\ifdefined\\FloatBarrier\\FloatBarrier\\fi'
  return pandoc.RawBlock('latex', barrier .. '\n' .. latex .. '\n' .. barrier)
end

-- `breakable` for a box that must be allowed to split, `breakable=false` for one that is
-- PINNED -- which since round 8's second pass means it both fits and would strand a tail.
local function breakOption(pinned)
  return pinned and 'breakable=false' or 'breakable'
end

-- A LaTeX COMMENT recording what the estimator decided and why, emitted immediately before
-- every callout box.
--
-- WHY IT EXISTS. A pinned box that does not fit the text block does not warn and does not
-- overfull -- it hangs xelatex (see FIT above). The only way to know a pin decision was right
-- is to typeset the box and measure it, which `scripts/check-pinned-callouts.js` does on the
-- emitted .tex before xelatex sees the book. That check needs three things this filter is the
-- only holder of: the estimate the decision was made with, the callout type, and the title
-- (so a failure can name the box rather than a byte offset). None of them survives into the
-- LaTeX any other way, and re-deriving the estimate in JavaScript would be a second
-- implementation of the estimator -- which is exactly the thing being checked.
--
-- It is a comment, so it is inert in TeX and costs the output nothing. The format is
-- deliberately rigid and machine-first (key=value, one line, `%` in column 1):
--
--     %%CALLOUTFIT type=code pinned=1 est=308.70 budget=433.6 title=Code
--
-- `est=?` means the estimator declined to measure the box (an Image, a raw inline, a table,
-- a hard break it could not place), in which case `pinned` is always 0. A line is written for
-- EVERY callout, pinned or not, so the check can also report how close an unpinned box came.
--
-- `pinned` is the DECISION (fit AND a strandable tail) and must equal the box's own
-- `breakable=false`: check-pinned-callouts.js cross-checks the two and errors if they
-- disagree. `fits=` records the fit answer alone, so the check can still report how close an
-- unpinned box came -- since round 8's second pass most unpinned boxes fit and were left
-- breakable on purpose, and without this key that distinction is unrecoverable from the .tex.
-- `idx` is the callout's 1-based ordinal in document order, counting EVERY callout this
-- filter emits, pinned or not. check-pinned-callouts.js derives the same number by counting
-- %%CALLOUTFIT lines in the .tex (findCallouts: `index: callouts.length + 1`), so the two
-- agree by construction -- and the check asserts it rather than trusting it. The ordinal is
-- what keys measured heights back into this filter on the second pass; titles cannot, because
-- every `::: code` box is titled "Code".
local CALLOUT_ORDINAL = 0

local function emitFitProvenance(calloutType, pinned, estimate, title, fits)
  CALLOUT_ORDINAL = CALLOUT_ORDINAL + 1
  -- One line, always. A title is an attribute value and so cannot contain a newline, but a
  -- control character or a stray `\n` from a future caller would comment out the
  -- \begin{tcolorbox} that follows, so it is flattened and bounded rather than trusted.
  local safe = tostring(title or '')
    :gsub('[%c]', ' ')
    :gsub('%s+', ' ')
    :gsub('^%s*(.-)%s*$', '%1')
  if charcount(safe) > 180 then safe = safe:sub(1, 180) end
  return string.format(
    '%%%%CALLOUTFIT idx=%d type=%s pinned=%d est=%s budget=%s fits=%d title=%s',
    CALLOUT_ORDINAL,
    calloutType,
    pinned and 1 or 0,
    estimate and string.format('%.2f', estimate) or '?',
    PIN_BUDGET and tostring(PIN_BUDGET) or 'none',
    fits and 1 or 0,
    safe)
end

-- Generate conversation callout (chat-style with human/AI/reflection) - Print style
--[[
  `varwidth boxed title` bounds the title box so a long one wraps instead of running off
  the paper. promptref titles are prompt names -- "Implement Infrastructure Health Checks
  For Databases, Caches, APIs, And Filesystems" -- and an attached boxed title is a single
  unbreakable line by default. At the 6x9 trim's 4.75in measure those reached x=452pt on a
  432pt page: past the trim, not merely past the margin.

  Note these LaTeX templates are consumed by string.format, so a literal % must be written
  %% -- which is why the explanation lives here rather than as a LaTeX comment inside them.
--]]

-- A conversation callout is NEVER pinned, on purpose.
--
-- It is the only callout whose body is itself a stack of tcolorboxes -- one per Human / AI /
-- Reflection turn -- and each of those adds its own frame rule, 0.3em of padding top and
-- bottom and 0.5em of before/after skip. That per-turn overhead is unmeasured here, and its
-- error would compound with the turn count, which is exactly where an underestimate stops
-- being a cosmetic fault and hangs the build (see FIT above). None of the six instances the
-- publisher's review and the fault detector found is a conversation callout, so there is
-- nothing to buy with that risk. Conversation callouts do get the float barriers.
function generateConversationCallout(content)
  -- `est=?` and `pinned=0`, honestly: no estimate is taken for a conversation box at all.
  local latex = emitFitProvenance('conversation', false, nil, callouts.conversation.title) .. '\n' .. [[
\begin{tcolorbox}[
  colback=teal!5!white,
  colframe=teal!75!black,
  title={Conversation},
  breakable,
  enhanced,
  attach boxed title to top left={yshift=-2mm, xshift=2mm},
  varwidth boxed title=0.82\linewidth,
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
  return barriered(latex)
end

-- Generate prompt reference callout (prominent link with preview) - Print style
-- Anatomy: title (prompt name), url (prompt link), content (description + preview)
-- Content structure: First paragraph(s) = description, last paragraph = preview (shown in italics)
-- Renders: description, preview in italics (elided), then "Link: [prompt name]" with footnote
function generatePromptRefCallout(content, elem)
  -- Extract title (prompt name) and URL (prompt link) from attributes
  local promptName = elem.attributes.title or "Prompt Reference"
  local promptUrl = elem.attributes.url or "#"

  -- Separate content into description (all but last paragraph) and preview (last paragraph)
  local numBlocks = #content

  -- Four of the five orphaned tails in round 7 were THIS box: the Link: line and its
  -- footnote are the last things in it, so when it split they were what went overleaf --
  -- a rule and a bare URL in a box fragment at the head of the next page. Everything the
  -- box adds below the content has to be counted, or the box is pinned a few lines short.
  local extra = FIT.em * 0.5                                        -- \vspace{0.5em}
    + FIT.text_line * wrapped('Link: ' .. promptName, FIT.text_chars) -- the Link: line
    + FIT.note_base + FIT.note_line * math.max(2, wrapped(promptUrl, FIT.note_chars))
  if numBlocks > 1 then
    extra = extra + FIT.em * 0.3                                    -- \vspace{0.3em}
  end
  local fits, estimate = calloutFitsOnePage(content, { title = promptName, extra_height = extra })
  -- A promptref's tail is a `Link:` line and its footnote, degenerate by construction, so the
  -- tail test below cannot tell one promptref from another -- it would pin all 66. Pin the
  -- named ones instead: the five that actually orphan. See readPinTitles() and the note in
  -- book.config.js. With no list declared this is every promptref that fits, which is the
  -- round-8-first-pass behaviour and costs 16 pages.
  if PIN_TITLES[promptName] then PIN_TITLES_SEEN[promptName] = true end
  local pinned = fits and (next(PIN_TITLES) == nil or PIN_TITLES[promptName] == true)

  local latex = emitFitProvenance('promptref', pinned, estimate, promptName, fits) .. '\n' .. string.format([[
\begin{tcolorbox}[
  colback=cyan!5!white,
  colframe=cyan!75!black,
  title={%s},
  %s,
  enhanced,
  attach boxed title to top left={yshift=-2mm, xshift=2mm},
  varwidth boxed title=0.82\linewidth,
  boxed title style={size=small,colback=cyan!75!black},
  top=0.75em,
  bottom=0.5em
]

]], promptName, breakOption(pinned))

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
  return barriered(latex)
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

  -- The p.80 instance the publisher reported was one of these: a `::: code` callout holding
  -- a 16-source-line JSON sample that split so that "] } } } }" opened the page alone.
  -- config.title is a fixed word ("Code", "Info", ...), so the boxed title never wraps.
  local fits, estimate = calloutFitsOnePage(content, { title = config.title })
  -- The p.80 box is exactly this case: it fits AND its JSON ends in five closers, so it pins.
  -- Its 24 neighbours that merely fit now stay breakable, which is where the pages come back.
  local pinned = fits and tailWouldStrand(content)

  local latex = emitFitProvenance(calloutType, pinned, estimate, config.title, fits) .. '\n' .. string.format([[
\begin{tcolorbox}[
  colback=%s!5!white,
  colframe=%s!75!black,
  title={%s},
  %s,
  enhanced,
  attach boxed title to top left={yshift=-2mm, xshift=2mm},
  varwidth boxed title=0.82\linewidth,
  boxed title style={size=small,colback=%s!75!black},
  top=0.75em,
  bottom=0.5em%s
]
]], config.latexcolor, config.latexcolor, config.title, breakOption(pinned),
    config.latexcolor, extraOptions)

  -- Add content
  for _, block in ipairs(content) do
    latex = latex .. pandoc.write(pandoc.Pandoc({block}), "latex") .. "\n"
  end

  latex = latex .. "\\end{tcolorbox}"

  return barriered(latex)
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

-- THE LEAD-IN RESERVATION, resized to the box it is holding space for.
--
-- keep-leadin-with-content.lua puts `\needspaceNow{9\baselineskip}` in front of a lead-in
-- that introduces a callout. Nine baselines is right for a box that can SPLIT: enough to
-- start it, the rest flows over. It is wrong for a pinned box, which needs its whole height
-- or it moves -- and when it moves, the lead-in has already been placed on those nine lines
-- and is left at the page foot alone. That is "Essential steps:" (p.95), "Key
-- implementations:" (p.101) and "Managing knowledge evolution:" (p.144): three class-4
-- faults round 7 did not have, created by pinning to take class 2 from 5 to 0.
--
-- THAT FILTER CANNOT FIX IT ITSELF. It runs BEFORE this one (pandoc-defaults-print.yaml),
-- deliberately, so that lead-ins inside a callout are still reachable as blocks; at that
-- point the callout is a Div and no height exists. This filter is where the height is known,
-- so this is where the reservation is corrected -- after Div handlers have run, the box is a
-- RawBlock carrying its own `%%CALLOUTFIT ... pinned=1 est=NNN` provenance.
--
-- Only ENLARGES. A box shorter than the nine lines already reserved keeps the nine, so this
-- can never reserve less than before and never makes an existing break worse.
local RESERVED_NINE_PT = FIT.text_line * 9

-- THE RESERVATION USES A DE-BIASED ESTIMATE. THE FIT DECISION DOES NOT. The two want safety
-- in OPPOSITE directions, so they must not share a number:
--
--   * calloutFitsOnePage() asks "can this box fit a page at all?". Under-estimating there
--     pins a box that does not fit, which HANGS xelatex (see THE CLIFF above). It keeps the
--     raw estimate and stays deliberately high.
--   * This reservation asks "how much space must I hold open?". Over-reserving here does not
--     hang anything -- it breaks the page early and leaves the difference as blank paper.
--
-- scripts/check-pinned-callouts.js measures every pinned box's REAL height and reports it
-- against the estimate. Over the nine boxes this book pins, measured/estimate is:
--
--     promptref  n=6   0.822 .. 0.877   (mean 0.848)
--     code       n=3   0.880 .. 0.997   (mean 0.957)
--
-- promptref drifts high and tightly: the estimator pads title wrapping and the note block,
-- neither of which costs what it budgets. 0.90 sits above the worst observed promptref ratio
-- (0.877) with 2.6% to spare, so the reservation still cannot land UNDER the box -- which is
-- the one failure that matters here, because a short reservation places the lead-in and then
-- lets the box move out from under it, recreating the class-4 fault this code exists to
-- prevent. Code boxes estimate almost exactly (0.997 worst case) and get no discount.
--
-- Worth 42.5pt on "Revise Memory Bank" alone -- three blank lines at the foot of p.140.
-- Re-run check-pinned-callouts.js after changing the FIT constants: if a ratio ever exceeds
-- the factor below, this reservation has become a source of stranded lead-ins.
local RESERVE_FACTOR = { promptref = 0.90 }

local function pinned_estimate(blk)
  if not (blk and blk.t == 'RawBlock'
          and (blk.format == 'latex' or blk.format == 'tex')) then return nil end
  local prov = blk.text:match('%%%%CALLOUTFIT[^\n]*')
  if not prov or not prov:match('pinned=1') then return nil end
  -- Measured first: the pre-flight put real xelatex over this exact box. The de-biased
  -- estimate is the fallback for the first build of a tree (no pre-flight yet), for a box the
  -- pre-flight could not measure, and for any consumer running this filter outside
  -- build-book.js. See MEASURED_HEIGHTS above for why the fit decision does not get this.
  local idx = tonumber(prov:match('idx=(%d+)'))
  if idx and MEASURED_HEIGHTS[idx] then return MEASURED_HEIGHTS[idx] end
  local est = tonumber(prov:match('est=([%d%.]+)'))
  if not est then return nil end
  return est * (RESERVE_FACTOR[prov:match('type=(%a+)')] or 1.0)
end

local function is_reservation(blk)
  return blk and blk.t == 'RawBlock' and blk.text:match('needspace')
     and blk.text:match('{%d+\\baselineskip}')
end

function Blocks(blocks)
  for i = 2, #blocks do
    local est = pinned_estimate(blocks[i])
    if est and est > RESERVED_NINE_PT then
      -- Look back past the lead-in for the reservation. Two blocks is the shape the sibling
      -- filter emits (reservation, lead-in paragraph, box); one covers a pipeline that drops
      -- the paragraph. Anything further back belongs to different content and is left alone.
      for back = 1, 2 do
        local res = blocks[i - back]
        if is_reservation(res) then
          -- +1 baseline for the lead-in itself, which sits BELOW this reservation and so is
          -- not part of the box's measured height.
          res.text = res.text:gsub('{%d+\\baselineskip}',
            string.format('{\\dimexpr %.2fpt + \\baselineskip\\relax}', est))
          break
        end
      end
    end
  end
  return blocks
end

-- Return the filter.
--
-- TWO PASSES, IN THIS ORDER. A single filter set walks blocks BEFORE Meta, so reading the
-- pin budget in the same table as Div would read it after every pinning decision had already
-- been made -- and made with PIN_BUDGET still nil, so nothing would ever pin. Returning a
-- LIST runs the sets in sequence over the whole document, which is the only way a Div handler
-- can see document metadata.
return {
  {
    Meta = function(meta) readPinBudget(meta); readPinTitles(meta); readMeasuredHeights(meta) end
  },
  {
    Div = Div,
    -- Same set as Div on purpose: pandoc applies a block list's handler AFTER its children,
    -- so by the time Blocks sees the list every callout Div in it is already the RawBlock
    -- whose provenance Blocks reads. A third pass would also work and costs another walk.
    Blocks = Blocks
  },
  {
    -- A THIRD pass, only to report. Filter sets run in sequence over the whole document, so
    -- by the time this one starts every callout has been seen and PIN_TITLES_SEEN is final.
    -- Doing it inside the set above would report on a partly walked document.
    Pandoc = function(doc) reportUnmatchedPinTitles(); return doc end
  }
}
