# System Patterns: Book-Builder

**Last Updated**: January 2, 2026
**Project**: Reusable Book Publishing System
**Context**: System architecture, build process, and design patterns

---

## System Architecture

### High-Level Overview

```
Book Project (Parent Repository)
├── content files (*.md)
├── metadata.yaml
├── package.json
├── build.js (wrapper)
└── book-builder/ (git submodule)
    ├── scripts/        # Build automation
    ├── templates/      # LaTeX, HTML templates
    ├── fonts/          # Atkinson Hyperlegible
    ├── styles/         # CSS, citation styles
    ├── config/         # Pandoc defaults
    └── examples/       # Sample projects
```

### Core Components

**1. Build Scripts (Node.js)**
```
scripts/
├── build-book.js          # Main build orchestrator
├── validate-emojis.js     # Emoji validation
├── validate-links.js      # Link checking
└── clean-build.js         # Cleanup utility
```

**2. Templates**
```
templates/
├── book-digital.latex     # PDF template (interactive)
├── book-print.latex       # PDF template (print-ready)
├── book.html              # HTML template
├── filters/
│   ├── callout-filter-digital.lua  # Callout rendering (digital)
│   ├── callout-filter-print.lua    # Callout rendering (print)
│   ├── minted-filter.lua           # Code highlighting
│   └── link-filter.lua             # Link processing
└── metadata.yaml          # Template metadata
```

**3. Configuration**
```
config/
├── book.config.js                  # Build configuration
├── pandoc-defaults-digital.yaml    # Pandoc settings (digital)
└── pandoc-defaults-print.yaml      # Pandoc settings (print)
```

**4. Assets**
```
fonts/                     # Atkinson Hyperlegible (10MB)
├── AtkinsonHyperlegibleNext-Regular.ttf
├── AtkinsonHyperlegibleNext-Bold.ttf
└── ... (all weights and styles)

styles/
├── book.css              # HTML styling
└── citations/            # CSL citation styles
```

---

## Build Process Flow

### Phase 1: Validation

```
build-book.js
    ↓
Validate Prerequisites
    ├── Check Pandoc version (3.7+)
    ├── Check XeLaTeX (if PDF target)
    └── Check Node.js dependencies
    ↓
Validate Emoji Usage
    ├── Scan all .md files
    ├── Check against approved list
    └── Report violations (fail build)
    ↓
Continue to Phase 2
```

### Phase 2: Content Processing

```
Process Source Files
    ↓
For each content file (foreword, chapters, appendices):
    ├── Read markdown content
    ├── Inject chapter/appendix images
    ├── Process {REPO_BASE} placeholders
    ├── Apply format-specific transforms
    └── Write to build/intermediate/
    ↓
Copy images to build/assets/
    ↓
Continue to Phase 3
```

### Phase 3: Book Generation

```
Generate Book with Pandoc
    ↓
Build Pandoc Command
    ├── Input: all intermediate .md files (in order)
    ├── Output: build/{target}/constellize-book.{ext}
    ├── Format: pdf / html5 / epub3
    ├── Defaults: config/pandoc-defaults-{variant}.yaml
    ├── Template: templates/book-{variant}.latex
    ├── Filters: Lua filters for processing
    ├── Bibliography: references.json
    ├── Metadata: from metadata.yaml
    └── Engine: xelatex (for PDF)
    ↓
Execute Pandoc
    ↓
XeLaTeX Processing (for PDF)
    ├── Multiple passes for cross-references
    ├── Font loading (Atkinson Hyperlegible)
    ├── Image embedding
    ├── TOC generation
    └── PDF output
    ↓
Build Complete
```

---

## Design Patterns

### Pattern 1: Wrapper Script Delegation

**Context**: Parent book project needs simple interface to build system.

**Solution**: Lightweight wrapper (build.js) delegates to submodule scripts.

**Implementation**:
```javascript
// book/build.js
const buildScript = path.join(__dirname, 'book-builder', 'scripts', 'build-book.js');
const args = ['.', ...process.argv.slice(2)].join(' ');
execSync(`node ${buildScript} ${args}`, { stdio: 'inherit', cwd: __dirname });
```

**Benefits**:
- Simple parent project setup
- All complexity in submodule
- Easy to update build system

### Pattern 2: Content Directory Parameter

**Context**: Build scripts need to work from different locations.

**Solution**: Accept content directory as first parameter, resolve all paths relative to it.

**Implementation**:
```javascript
// book-builder/scripts/build-book.js
const config = require('../config/book.config.js');
config.source.root = process.argv[2] || path.resolve(__dirname, '../..');

const contentDir = config.source.root;
const metadataPath = path.join(contentDir, 'metadata.yaml');
const chaptersPath = path.join(contentDir, 'ch*.md');
```

**Benefits**:
- Works as submodule or standalone
- Flexible deployment options
- Testable with different content

### Pattern 3: Target-Specific Defaults

**Context**: Different output targets need different configurations.

**Solution**: Separate pandoc-defaults-{target}.yaml files for each output variant.

**Files**:
- `pandoc-defaults-digital.yaml` - Interactive PDF with hyperlinks
- `pandoc-defaults-print.yaml` - Print-ready PDF/X-1a

**Implementation**:
```javascript
// In book.config.js
outputs: {
  digital: {
    defaultsFile: 'book-builder/config/pandoc-defaults-digital.yaml',
    format: 'pdf',
    pdfType: 'interactive'
  },
  print: {
    defaultsFile: 'book-builder/config/pandoc-defaults-print.yaml',
    format: 'pdf',
    pdfType: 'x1a'
  }
}
```

**Benefits**:
- Clean separation of concerns
- Easy to maintain variants
- Correct filters for each target

### Pattern 4: Lua Filters for Transformation

**Context**: Markdown needs transformation before LaTeX/HTML generation.

**Solution**: Pandoc Lua filters modify AST during processing.

**Filters**:
1. **minted-filter.lua**: Code block → Minted environment
2. **callout-filter-digital.lua**: ::: callout → tcolorbox with left bar
3. **callout-filter-print.lua**: ::: callout → tcolorbox print-safe
4. **link-filter.lua**: Process and validate links

**Processing Order**:
```
Markdown → Parse → AST
    ↓
minted-filter (code blocks)
    ↓
callout-filter (div elements)
    ↓
link-filter (links)
    ↓
LaTeX/HTML Generation
```

**Benefits**:
- Powerful transformation capabilities
- Format-specific processing
- Maintainable and testable

### Callout page breaks: what works, what cannot work (print)

**Context**: Round 7 of the publisher's review reported two faults around callout boxes in
`callout-filter-print.lua`. The fault detector (`scripts/detect-typeset-faults.py`) measured
six instances in the round-7 PDF: a figure placed between a callout and its own footnote
(p.215), and five callouts that split and shed an orphaned tail (pp. 80, 105, 108, 112, 141).
Four of those five were **promptref** boxes, not code listings.

**Three things that cannot work. Do not spend another round on them.**

| Attempt | Why it is inert |
| --- | --- |
| `\widowpenalty`, `\brokenpenalty`, fancyvrb's last-line widow penalty | **tcolorbox's splitting ignores penalties in box content.** Verified by placing an explicit `\penalty10000` at the observed break point: the break did not move. |
| A "minimum lines after a break" rule, which the publisher suggested | **There is no `lines after break` key.** `lines before break` (set in `book-print.latex`) governs only the part BEFORE a split. Nothing in tcolorbox governs the part after one. |
| `breakable=false` on every code callout (tried in an earlier round) | Orphans went to zero but the book went 261 → 269pp and two lead-ins were stranded, because it pinned long listings that have to split. |

**What works**: pin only the boxes that fit. A box set `breakable=false` cannot split, so it
either fits where it is or moves whole to the next page; it never sheds a tail. Bounding the
pinning to boxes that fit bounds the page cost to the tallest box deliberately pinned. A
promptref's footnote is set INSIDE its own box (tcolorbox collects footnotes at the box
foot), so pinning keeps the footnote with the `Link:` line it belongs to — which is what the
four promptref instances were about.

**THE CLIFF, and why the threshold is conservative.** A pinned box that does not fit the text
block does **not** degrade into an `Overfull \vbox`. xelatex **spins forever**, shipping empty
pages — 139,000 of them before the probe was killed. Measured at the 6×9 trim with this
template: a pinned code callout of 35 rendered lines (≈544pt) typesets; 36 (≈558pt) never
terminates. An estimate that runs high therefore costs the build, not a warning, so the
estimator leaves anything it cannot measure confidently breakable.

**The threshold: an estimated box height of 433pt, which is 80% of the text block.**
In whole lines that is **27 rendered lines of a code callout** or **24 rendered lines of a
text callout**. The tallest box the book actually pins estimates at 429pt (79% of the text
block, 113pt of headroom).

**Source lines are not rendered lines.** `\setminted` runs `breaklines=true,
breakanywhere=true`, so one logical line can occupy two or three typeset lines. The p.80 JSON
sample is 16 source lines and 17 rendered ones.

**THE PROBE IS COMMITTED: `scripts/__tests__/fixtures/fit-probe.md`.** It re-derives every
constant below, and its header carries the exact pandoc + xelatex commands, the reference
measurements from 2026-11-02, and the arithmetic from each pair of measurements to each
constant. Run it instead of trusting this table; these two numbers were the inputs to a
decision whose wrong answer is an infinite build, and before round 8's fix wave they existed
only as the prose below — produced once, by one implementer, and never falsified.

The probe wraps REAL `::: info` / `::: code` / promptref callouts in `\setbox0=\vbox{...}` with
raw-LaTeX blocks on either side, so it measures the filter's own output and there is no second
copy of the LaTeX to drift. It is `grep FITPROBE` on the xelatex log. Two traps it documents:
minted needs two xelatex passes or every code box measures as empty, and callout body
PARAGRAPHS are rendered as one LaTeX paragraph by `generateLatexCallout` (one `pandoc.write`
per block joined by a single newline), so the probe counts body lines with LINE BLOCKS. The
estimator counts paragraphs separately and therefore runs high on a multi-paragraph callout,
which is the safe direction.

**`title_line` was 1.65pt LOW and is now corrected to 19.65 (2026-11-02).** The probe isolates
it as `(title-83 - title-11) - text_line` = 35.97 − 16.32: a promptref repeats its title in its
own `Link:` line, so each step in title length moves a boxed-title line AND a body line, and
one `text_line` has to be backed out. **It is not linear.** The 1→2 step costs 19.65pt and the
2→3 step only 13.03pt, because the attached boxed title is laid over the box's own
`top=0.75em` padding — the first extra line eats room that is already there. `FIT` holds the
LARGER step and applies it to every line over the first: that over-estimates a 3-line title by
6.6pt (safe, a box stays breakable), where holding 13.03 would under-estimate every 2-line
title by the same (not safe). No title in this book reaches three lines.

**`note_base` was 0.19pt LOW and is now corrected to 10.19 (2026-11-02).**
`note-longurl - note-absent` measures 32.19 against the old 10 + 2×11 = 32.00, and `note_line`
is exactly 11.00, so the whole 0.19 sat in `note_base`. It was left at 10.00 for a round on the
argument that 0.19pt once per box is covered by a `FIT.box` that runs 2.29pt HIGH. That is true
and it is not the point: a constant that runs LOW is the direction that pins a box which does
not fit, and a table that disagrees with its own probe is how `title_line` stayed 1.65pt low
for a whole round. **It moved nothing** — it raises 65 promptref estimates by 0.19pt each, the
largest of them to 388.40pt against a 433.6pt budget, so no box changed pin status and the
rendered book is unchanged. The nearest thing to a margin is the "Leverage AI Assistance"
promptref at **433.84pt, 0.24pt OVER the budget and breakable because of it**: the correction
pushed it 0.19pt further from being pinned, which is the direction to be wrong in.

**`code_chars` describes only the FIRST rendered line of a code line (2026-11-02).** minted's
`breakautoindent` is on by default and `\setminted` does not turn it off, so a wrapped code
line's continuations are indented under the ORIGINAL line's leading whitespace and hold
`code_chars - indent` characters, not `code_chars`. `wrapped_code()` in the filter does that
arithmetic; `wrapped()` (which did not) under-counted a 96-character line indented 8 spaces as
2 rendered lines where minted sets 3. That one line was the largest estimator drift in the
book — the pre-flight measured a code callout at **383.82pt against a 371.50pt estimate,
+12.32pt**, one `code_line`. Corrected, that box estimates 385.90 and drifts **−2.08pt**, and
the book's worst drift falls to **+1.69pt**, inside the pre-flight's 2pt tolerance. It changed
exactly one estimate and **no box's pin status**: 123 pinned before and after, 267 pages
either way.

**THE CLIFF HAS NO COMMITTED PROBE, DELIBERATELY.** A probe that reproduces it does not
terminate, and a committed one would eventually be run by somebody who had not read why. The
procedure for re-deriving it by hand — including the exact content that produced 35 safe / 36
unterminating, that it must be run in a terminal you are watching, and that you will have to
kill it — is written out at the foot of `fit-probe.md`.

**How every constant was measured** (the original derivation, superseded by the probe above but
kept because the numbers agree: a markdown file of `{=latex}` blocks run through
`pandoc-defaults-print.yaml` and `book-print.latex`, each quantity captured with
`\setbox0=\vbox{...}\typeout{\the\ht0}`; minted needs two xelatex passes before its content
exists, or every code box measures as empty):

| Constant | pt | Derivation |
| --- | --- | --- |
| `text_block` | 542.03 | `\the\textheight`: 9in paper less 0.75in top and bottom |
| `box` | 34.00 | info box with 1 body line (50.00) less one body line |
| `title_line` | 19.65 | 83-character title less 11-character title, less one `text_line` for the `Link:` line that also grew; the larger of two unequal steps (see above) |
| `title_chars` | 42 | an 83-char title takes 2 lines, a 122-char title 3; held back from the ~56 the 0.82\linewidth measure allows |
| `text_line` | 16.32 | info box 2 paragraphs (66.32) less 1 paragraph (50.00); linear to 11 paragraphs (213.20) |
| `text_chars` | 50 | 58 characters still set as one line, 60 wrapped; held back for justification and bold/italic runs |
| `code_line` | 14.40 | code box 21 minted lines (342.37) less 1 line (54.37), over 20 |
| `code_chars` | 48 | the geometric measure takes 56 (56 chars fit, 58 overfull by 6.1pt), but breaklines breaks at the last break point BEFORE the measure and indents the continuation under the hook symbol: the book's own 62-char line broke after 49. **The FIRST rendered line only** — `breakautoindent` gives a continuation `48 - indent` (see above) |
| `code_pad` | 6.30 | code box overhead (39.97) less text box overhead (34.00) |
| `note_base`, `note_line`, `note_chars` | 10.19, 11.00, 40 | promptref box with a long-URL footnote (101.28) less the same without one (69.28) = 32pt = rule+skip plus 2 lines; a short URL costs 21pt = rule+skip plus 1 line |
| `em` | 11.00 | the body font size, for the promptref box's `\vspace{0.3em}` and `\vspace{0.5em}` |

**PINNING IS OPT-IN, AND THE TEMPLATE IS WHAT OPTS IN.** Every constant in the table above
describes ONE page geometry. book-builder is shared, and `config/pandoc-defaults-print.yaml`
names the filters but deliberately names no template — the template comes from each consuming
book's own `book.config.js`. So a book using these print defaults with an A5 or 10pt template
would have had its boxes pinned against this book's 542pt text block, and the failure mode is
not a warning but a non-terminating xelatex. The filter therefore pins NOTHING until a budget
is declared:

- `templates/book-print.latex` defines `\newcommand{\calloutPinBudget}{433.6}`, beside the
  `geometry` block that justifies the number;
- `build-book.js` reads that definition out of whichever template the target names
  (`scripts/lib/callout-pin-budget.js`) and forwards it as
  `--metadata=callout-pin-budget:433.6`;
- the filter reads it on a Meta pass that runs BEFORE its Div pass (the filter file returns a
  LIST of two filter sets for exactly this reason — a single set walks blocks before Meta, so
  every pinning decision would be taken with the budget still unread), sanity-checks it
  (a positive number of points, at most 1000) and otherwise leaves `PIN_BUDGET` nil.

With no declaration every callout comes back `breakable`, which is the pre-round-8 behaviour:
correct, a few more split boxes, and no hangs. The filter says so on stderr rather than
silently, so a build that lost the metadata cannot read as a clean pinning pass. Same
convention as this round's `\ifdefined\FloatBarrier` and `\ifdefined\needspaceNow` guards —
the capability is declared where the capability lives — but a hard gate rather than a fallback,
because this one's failure mode is an infinite loop.

Model: `height = box + title overflow + Σ blocks + extras`, and a box is pinned when that is
`<= 433`. Predicted 543.97pt at 35 code lines against an empirically safe 35 and an
unterminating 36 — accurate to about 2pt at the cliff.

**EVERY branch that measures running text must go through `inline_extras()`.** That function
is the only place `Image` sets "unmeasurable" and the only place a `Note` is costed. Review
found two branches that walked inlines themselves and so pinned things they could not see,
both ending in a non-terminating xelatex that no log and no `\vbox` check can catch:

- a **`LineBlock`** summed its own lines, so a line block holding a half-page diagram measured
  at about 66pt and was pinned, and footnotes in one cost nothing;
- **`pandoc.utils.stringify()` flattens a `LineBreak` to a space**, so a paragraph written
  with trailing-double-space hard breaks measured as one long wrapped run while the renderer
  sets one line per break — 41 hard-broken lines estimated at roughly a third of their height,
  ~669pt against the 544pt cliff. The manuscript already writes such breaks (`ch1.md:138-141`,
  `ch5.md:46`, `ch5.md:71`, `introduction.md:184`); none is inside a callout yet, which is the
  only reason the build terminated.

Both are fixed: `lines_of_inlines()` splits an inline list at hard breaks, and a break it
cannot place (one nested inside `Strong`, a `Link`, a `Span` or a footnote) makes the box
unmeasurable rather than short. Four tests cover them, all of which fail against the first
version of the filter.

**A THIRD breach, found by the whole-branch review, and the one that names the shared cause:**
`pandoc.utils.stringify()` returns `""` for a `Note` (pandoc applies deNote) and `""` for a
`RawInline`. It is a plain-text flattener and neither element carries plain text. So

- every footnote was costed at `note_base + 2 x note_line` = **32pt regardless of its real
  height**, because `stringify(note)` was `""`. An `::: info` callout of 18 one-line paragraphs
  plus one ~2,800-character footnote estimated at 359.76pt and was PINNED, against a true
  height near 1,218pt. The fix is `stringify(note.content)`; with it the same box estimates at
  1,217.76pt and stays breakable, and every estimate across the manuscript is unchanged
  (123 pinned before and after);
- a **`RawInline` measured as zero characters**, so a callout containing
  `` `\vspace{20cm}`{=latex} `` was pinned. It is now unmeasurable, like an `Image`.

`lines_of_inlines()` deliberately does NOT count note text — a footnote is set at the foot of
the box, not in the running text, and `inline_extras()` costs it there; counting it in both
places would double it. The RawInline case is not harmless the same way, which is why that one
makes the whole box unmeasurable instead.

The lesson generalises: **anything reached for by stringifying a container is invisible if it
is not plain text.** Every branch that measures running text goes through `inline_extras()`,
and `inline_extras()` is the only place that knows which elements stringify cannot see.

**Known interaction, NOT fixed: a callout containing its own lead-in can never be pinned.**
`keep-leadin-with-content.lua` runs first and walks into callout `Div`s on purpose, so it
inserts its `\needspace` RawBlock into the box's own content; `estimate_block()` sees an
unrecognised LaTeX RawBlock and answers nil. That fails safe, but it means fault B can quietly
return for any callout that gains a sentence ending in a colon, with nothing in the page or
the test suite to say why that box behaved differently. Written up in the filter at the foot
of `estimate_block()`.

### The pre-flight fit check, and the timeout behind it (round 8, final wave)

**The estimator is no longer the only thing standing between a pin decision and a hung
build.** `scripts/check-pinned-callouts.js` runs BETWEEN pandoc and xelatex on every print
build: it typesets every `breakable=false` box ON ITS OWN, in a minimal document built from
the book's real preamble, measures it with `\setbox0=\vbox{...}` / `\the\dimexpr\ht0+\dp0`,
and **fails the build naming the box** if the measured height exceeds `\textheight`.

Four things about it that are load-bearing:

- **It measures; it does not re-check the estimate.** Checking a pinned box against the
  estimator is circular — the estimator is what decided to pin it. All three breaches above
  were found by reading code, not by anything the build measured.
- **IT DOES NOT SHIP A BOX TO A PAGE.** Each box is measured inside a `\vbox` and discarded.
  Putting an unbreakable box ON a page is exactly the operation that hangs, so a check that
  rendered them would reproduce the fault it exists to prevent. A test asserts the probe
  document contains no `\box0`, `\copy0` or `\unvbox`.
- **It is the one hard failure in this build system**, and it is hard because the alternative
  is not a worse book but an infinite build. Everything else here degrades to "not measured".
  Without TeX, or with no pinned boxes in the document, it reports NOT CHECKED and exits 0 —
  never a green pass over something it did not measure.
- **It is geometry-independent, which is what makes it safe for a consuming book.** It reads
  `\textheight` out of the probe run of that book's own preamble, so a book with an A5 or 10pt
  template that declares a `\calloutPinBudget` gets checked against ITS page, not this one's.
  A template that declares no budget pins nothing, so there is nothing to check and the check
  does not run at all.

**How the filter tells it what the estimate was.** `callout-filter-print.lua` opens every
callout's raw block with a one-line LaTeX comment:

    %%CALLOUTFIT type=code pinned=1 est=371.50 budget=433.6 title=Code

`est=?` means the estimator declined to measure the box. The comment is the only place the
estimate exists after pandoc has run, and re-deriving it in JavaScript would be a second
implementation of the thing being checked. It rides inside the SAME `RawBlock` as the box and
its barriers, for the same reason the barriers do (see above): its own block would be the one
`keep-leadin-with-content.lua` matched.

**The check also reports ESTIMATOR DRIFT**: any pinned box whose measured height exceeds its
own estimate by more than 2pt, even when it still fits. That is a `FIT` bug, and an unnoticed
one is how a box that fits today becomes a hang after a sentence is added to it. Drift is
reported, not fatal — the fit check is what stands between it and the cliff. 2pt is chosen
because the estimator is built to run HIGH (`FIT.box` holds 34.00 against a measured 31.71),
so a measured height within a couple of points of the estimate already means a constant is
wrong.

**THE TIMEOUT BACKSTOP.** `scripts/lib/xelatex-keep-log/xelatex` now caps each xelatex run at
`XELATEX_TIMEOUT` seconds (`build-book.js` sets 600), kills it on expiry, leaves a marker file
so the build can tell a timeout from any other non-zero exit, and exits 124. `build-book.js`
turns that into an error that names pinned callouts as the likely cause and says to comment
out `\calloutPinBudget` and rebuild as the discriminating experiment. `timeout(1)` is
deliberately NOT used: it is GNU coreutils and absent from a stock macOS, so the watchdog is
POSIX sh.

**Why 600s**: measured 8–9 seconds per xelatex pass for this 267-page book, three passes, and
clearing the minted cache changed it by under a second. 600s is about 67x the slowest pass —
generous enough for a far slower machine and a longer book, bounded enough that a hung build
costs ten minutes instead of a day. A build that reaches it is broken; a build that is merely
slow must not be killed.

**One live drift finding, reported not fixed (2026-11-02).** One pinned `code` callout
measures 383.82pt against an estimate of 371.50pt — **+12.32pt, in the unsafe direction**. The
cause is not a `FIT` constant: `code_chars` models every rendered line as getting the same
width, but minted's `breakautoindent` aligns a wrapped continuation under the ORIGINAL LINE'S
INDENTATION, so a deeply indented 96-character source line (`ch?.md`'s
`when(promptService.getPromptById(samplePromptId))...`, 10 leading spaces) renders as THREE
lines where `ceil(96/48)` predicts two. The box has 158pt of headroom to `\textheight`, so it
is not a live hang; the model hole is real and is now measured on every print build.

**Deliberate exclusions** (each returns "do not pin", which is the pre-existing behaviour):
- **conversation callouts**, always. They are the only callout whose body is a stack of
  nested tcolorboxes, one per turn, each adding a frame rule, 0.3em of padding top and bottom
  and 0.5em of before/after skip. That per-turn overhead is unmodelled and its error compounds
  with the turn count — exactly where an underestimate stops being cosmetic and hangs the
  build. No reported instance was a conversation callout.
- any callout containing an **Image**, so a figure never measures as zero lines and gets
  pinned at an oversized height;
- a **Table** (a longtable cannot be pinned at all), a **Header** (unbounded
  `\@startsection` skips), a **DefinitionList**, and any raw LaTeX block that is not a
  recognised `minted` environment.

**Float barriers**: `\floatplacement{figure}{!ht}` is only a preference — a figure that does
not fit is still deferred and dropped at the top of a later page — and `placeins` with
`[section]` raises its barrier only at `\section`. The p.215 figure and its callout were in
the same section, so nothing stood between them. The filter now emits a `\FloatBarrier` on
each side of every callout.

Three things about that barrier:
- It travels **inside the same `RawBlock` as the box**. `keep-leadin-with-content.lua`
  recognises a callout as a `Div` (the print pipeline runs it before this filter) or as a
  LaTeX `RawBlock` containing `\begin{`, and reserves 9 lines for it rather than the generic
  5. A barrier in its own block is what that filter would see in a pipeline that ran the two
  the other way round, dropping the reservation to 5 and re-stranding the lead-ins rounds 5
  and 6 closed.
- It is guarded with `\ifdefined\FloatBarrier`, because `book-builder` is shared: a template
  that does not load `placeins` loses the barrier, not the build.
- `\FloatBarrier` issues a `\newpage` when floats are actually held (see `placeins.sty`), so
  a barrier in front of a callout can end a page early. `keep-leadin-with-content.lua`
  therefore issues the barrier **ahead of its own reservation**, so a held float is dumped
  before the lead-in rather than between the lead-in and the box it introduces. Without that,
  "For Stale Memory Banks ...:" sat at the foot of p.156 with Figure 5.4 and its callout
  overleaf.

### `\raggedbottom` in `book-print.latex` (round 8, final wave)

`book` + `twoside` leaves `\flushbottom` in force, so every page is stretched to the bottom
margin and the slack goes into whatever glue the page happens to have. With pinned callouts
that glue is usually the space between a **lead-in and the box it introduces**: p.117 of the
round-8 build set "Critical considerations:" alone in the middle of the page with ~115pt of
white above it and ~115pt below, disconnected from its own box. The build logged 84
`Underfull \vbox ... while \output is active`, one per page TeX could not fill.

Shipped 2026-11-02 at the owner's decision. **Measured over the whole book, before vs after:**

| | flushbottom | raggedbottom |
| --- | --- | --- |
| pages | 267 | **267** (no page cost) |
| `Underfull \vbox` | 84 | **0** |
| `Overfull \vbox` | 0 | 0 |
| `Overfull \hbox` | 3 | 3 |
| `Underfull \hbox` | 120 | 120 |
| detected faults (§1–§5) | 0/0/0/3/0 | 0/0/0/3/0 |
| pages whose body-line count changed | — | **0** |
| pages whose largest inter-line gap shrank | — | **152 of 267** |
| pages whose largest inter-line gap grew | — | **0** |
| sum of largest inter-line gaps | 18,348pt | 15,957pt |

**What it does and does not do.** It reflows nothing: not one page gained or lost a line, and
the sparse-page distribution is unchanged (106 pages under 20 body lines, median 23). It moves
white space **from between lines to the page foot**. A short page stays short — that is the
pinning's page arithmetic and no vertical-justification setting can change it — but it now
reads as a page that ended early rather than as loose type. p.117's gap went 129.9pt → 13.1pt;
p.84's 200.7 → 13.1; p.228's 467.5 → 243.8.

**Three of the six pages the owner named were already as tight as they could be** (p83, p203,
p209 are byte-identical before and after): they had no stretchable glue for `\flushbottom` to
pull on, which is precisely why TeX was reporting them underfull. The other three improved
(p148 8.1→4.8pt, p158 36.4→15.1pt, p91 30.3→16.8pt).

It is placed before the `header-includes` block, so a consuming book can put `\flushbottom`
back in its own header-includes and win.

**A TRAP RE-DISCOVERED WHILE SHIPPING IT.** The explanatory comment originally named the
header-includes block using pandoc's variable syntax. **pandoc expands template variables
before LaTeX sees the percent signs**, so the whole header-includes block was pasted onto a
commented line and everything after its first line leaked into the preamble; the build died
with `You can't use \spacefactor in vertical mode` and no pages. The copyright-page comment
further down `book-print.latex` already said this. A pandoc template has no safe way to write
a variable name inside a comment: don't.

That failure also exposed a gap in the pre-flight fit check, now closed: under `nonstopmode`
the probe measured on past the preamble error and reported all 123 boxes fitting, against a
preamble the real build refused. The check now reports NOT CHECKED when its own xelatex run
logs a TeX error, because its heights then describe a document that will not be built.

**EVERY reservation in front of a pinned box must be EAGER.** `\needspace` is lazy: it lays down
`\vskip 0pt plus N\baselineskip` and a −100 penalty and lets TeX choose later. That stretch is
what makes a nearly empty page look cheap, and an unbreakable box makes it visible, because
the next legal breakpoint is now a whole box away. Measured: p.118 of the first round-8 build
carried three lines and 90% white, shipped at badness 3861, because the only alternative break
lay past a 290pt pinned box and scored 100000. `\needspaceNow` (in `book-print.latex`) decides
immediately and emits **nothing at all** when the room is there, so there is no stretch left
for TeX to exploit. Switching the callout case to it took chapter 4 from 42 pages back to 39.

**TRIED AND REJECTED: making the HEADING reservations eager too.** `book-print.latex`'s
`\sectionbreak`, `\subsectionbreak` and `\subsubsectionbreak` are lazy `\needspace` as well,
and they carry the same pathology; per chapter the eager form looked like a clear win
(chapter 5: 28pp to 27pp, badly underfilled pages 6 to 3, no new Overfull `\vbox`). On the
whole book it took the sparse-page count from 14 to 11 at no page cost — **and stranded three
more lead-ins at page feet** (fault class 4: "Essential steps:", "Key implementations:",
"Managing knowledge evolution:"), taking that count from 3 to 6. Reverted. Do not re-try it
without a way to hold a lead-in to its content across a forced heading break; the chapter-level
measurement does not predict the book-level result here.

**What the fix costs, measured by ablation** (one chapter at a time, same template, four
filter variants):

| | ch3 | ch4 |
| --- | --- | --- |
| before this round | 19pp | 33pp |
| float barriers only | 20pp | 33pp |
| pinning only | 20pp | 42pp |
| both, lazy reservation | 22pp | 42pp |
| both, eager reservation | 22pp | **39pp** |

So the barriers are nearly free and the pinning is the whole cost, concentrated where the book
runs several promptref callouts back to back: two ~18-line boxes cannot share a 33-line page,
so one of them moves and the page loses the difference. The **trailing** barrier is free — a
build with only the leading barrier produced a byte-identical page vector — and it is kept
because it is the only guard against a figure declared inside a callout floating out of it.

Whole book: **257pp to 267pp**, and **86 to 106 pages under 20 body lines**. Count the sparse
pages that way, not by excluding figure pages and chapter openers: those are exactly the pages
that got sparsest, so excluding them hides the cost. That is the price of
"a callout that fits does not split", and it cannot be bought down without putting the split
tails back; it is visible mostly in §4.1, which runs a dozen promptref boxes in a row.

**Where that slack lands is a separate, cheaper question.** The class runs `\flushbottom`, so
each page is justified vertically and the slack is stretched into whatever glue exists — next
to an unbreakable box that means a gap BETWEEN a lead-in and its box rather than at the foot
of the page (84 `Underfull \vbox ... while \output is active` in the round-8 build).
`\raggedbottom` puts it at the foot instead: measured at ch3 22pp and ch4 39pp either way, so
**no page cost**, with `Underfull \vbox` going 7 → 0 and 23 → 0 and no new `Overfull \vbox`.
Not applied — it changes every page and is a house-style decision, not a defect fix — but it
is a one-line change to `book-print.latex` if it is ever wanted.

**Regression tests**: `scripts/__tests__/callout-filter.test.js` runs pandoc to LaTeX only —
no PDF — and asserts the barriers, the block structure that the lead-in filter reads, and
each pinning decision, including the three exclusions above.

### Pattern 5: Validation as Quality Gate

**Context**: Catch issues before expensive Pandoc/LaTeX processing.

**Solution**: Pre-flight validation checks that fail fast.

**Validations**:
1. **Emoji Check**: Only approved emojis (avoid rendering issues)
2. **Link Check**: All internal references exist
3. **Structure Check**: Required files present
4. **Prerequisites Check**: Tools available

**Implementation**:
```javascript
async validateEmojiUsage() {
  const violations = await validateEmojis(this.rootDir);
  if (violations.length > 0) {
    throw new Error(`Emoji validation failed: ${violations.length} violations`);
  }
}
```

**Benefits**:
- Fast failure (seconds vs minutes)
- Clear error messages
- Prevents partial builds

### Pattern 6: Build Artifacts Isolation

**Context**: Keep source clean, organize outputs clearly.

**Solution**: All build artifacts in build/ directory (gitignored).

**Structure**:
```
build/
├── intermediate/    # Processed markdown
├── assets/         # Copied images
├── digital/        # Digital PDF output
├── print/          # Print PDF output
├── web/            # HTML output
└── epub/           # EPUB output
```

**Benefits**:
- Clean git status
- Easy to clean (rm -rf build/)
- Organized outputs
- No pollution of source tree

---

## Critical Code Paths

### Path 1: PDF Build (Digital)

```
npm run build:digital
    ↓
book/build.js --target digital
    ↓
book-builder/scripts/build-book.js . --target digital
    ↓
Read config.outputs.digital
    ├── format: pdf
    ├── defaultsFile: pandoc-defaults-digital.yaml
    ├── template: book-digital.latex
    └── filters: [minted, callout-digital, link]
    ↓
Process content files → build/intermediate/
    ↓
pandoc \
  build/intermediate/*.md \
  --defaults=book-builder/config/pandoc-defaults-digital.yaml \
  --template=book-builder/templates/book-digital.latex \
  --output=build/digital/constellize-book.pdf
    ↓
XeLaTeX processes:
    ├── Load Atkinson Hyperlegible fonts
    ├── Apply tcolorbox styling (callouts)
    ├── Process Minted code blocks
    ├── Generate TOC and cross-references
    └── Output PDF
    ↓
build/digital/constellize-book.pdf
```

### Path 2: HTML Build

```
npm run build:web
    ↓
Similar to PDF but:
    ├── format: html5
    ├── No XeLaTeX (direct HTML output)
    ├── CSS styling from styles/book.css
    ├── Filters process differently for HTML
    └── Output: build/web/constellize-book.html
```

### Path 3: Emoji Validation

```
build-book.js starts
    ↓
validateEmojiUsage()
    ↓
validate-emojis.js
    ├── Scan all .md files (excluding node_modules, build/)
    ├── Extract emoji patterns
    ├── Check against approved list
    ├── Report violations with line numbers
    └── Return violations[]
    ↓
If violations.length > 0:
    └── Throw error, stop build
Else:
    └── Continue build
```

---

## Component Relationships

### Dependencies

**build-book.js depends on**:
- Node.js modules: fs-extra, chalk, commander, glob
- External tools: pandoc, xelatex
- Configuration: book.config.js
- Validation: validate-emojis.js
- Content: Parent project .md files

**Pandoc depends on**:
- Defaults files: pandoc-defaults-*.yaml
- Templates: book-*.latex
- Filters: *.lua
- Fonts: Atkinson Hyperlegible TTF files
- Content: Processed markdown in build/intermediate/

**XeLaTeX depends on**:
- LaTeX packages: tcolorbox, minted, hyperref, geometry
- Fonts: Embedded TTF files
- Generated .tex file from Pandoc

### Data Flow

```
User Content (.md)
    ↓ (processing)
Intermediate Files
    ↓ (pandoc)
LaTeX/HTML Document
    ↓ (xelatex or direct)
Final Output (PDF/HTML/EPUB)
```

---

## Evolution Strategy

### Versioning Approach

**Semantic Versioning**: MAJOR.MINOR.PATCH

- **MAJOR**: Breaking changes (template changes, config format)
- **MINOR**: New features (new filters, templates)
- **PATCH**: Bug fixes, documentation

**Current**: 1.0.0 (post-extraction from Constellize book)

### Upgrade Path for Parent Projects

**Scenario**: book-builder gets new feature

**Process**:
1. Develop and test in book-builder
2. Tag new version (e.g., v1.1.0)
3. Parent projects update submodule:
   ```bash
   cd book-builder
   git pull origin main
   cd ..
   git add book-builder
   git commit -m "Update book-builder to v1.1.0"
   ```

### Backward Compatibility

**Commitment**: Maintain backward compatibility within major versions.

**Breaking Changes Require**:
- Major version bump
- Migration guide
- Deprecation warnings in prior version
- Clear changelog

---

## Testing Strategy

### Unit Testing
- Lua filters (test AST transformations)
- Configuration loading
- Path resolution

### Integration Testing
- Build complete book from test content
- Verify all formats output correctly
- Check validation catches known issues

### Smoke Testing
- Example projects build successfully
- Fresh submodule integration works
- Common customizations work

---

## Decision Log

### Decision 1: Include Fonts vs External Requirement
**Decision**: Include fonts in repository (~10MB)
**Rationale**: Self-contained beats size concerns. Makes setup trivial.
**Date**: December 25, 2024

### Decision 2: Lua Filters vs Pandoc Extensions
**Decision**: Use Lua filters for transformations
**Rationale**: More powerful, better documented, easier to maintain
**Date**: December 2024

### Decision 3: Node.js vs Bash for Build Scripts
**Decision**: Use Node.js
**Rationale**: Cross-platform, better error handling, easier to extend
**Date**: December 2024

### Decision 4: Git Submodule vs NPM Package
**Decision**: Git submodule
**Rationale**: Source code access, easier customization, no npm registry dependency
**Date**: December 25, 2024

### `\clubpenalty` cannot protect a one-line paragraph

`\clubpenalty=10000` forbids leaving a paragraph's first line alone at a page foot, but it acts on a line break inside a paragraph. A one-line paragraph has no line break to penalise, so any paragraph that is only one line long (a standalone bold label, say) is strandable by construction, whatever the penalties are set to. What matters is the length of the whole paragraph, not the lead: a run-in bold lead followed by prose is only at risk if the entire paragraph fits on one line. This is why the fix for stranded labels (e.g. `**Day 1: ...**` alone at a page foot) is to fold them into the paragraph they introduce rather than to add keep-with-next machinery. `scripts/validate-structure.js` (`npm run validate:structure`, run by `make lint`) finds such bold-only blocks in source. It reports a warning and exits 0 by design: such labels are often legitimate, and this builder is shared, so a failing check would be switched off. Exit **2** means something different — the check did not RUN (no config, no `glob` because the submodule was never `npm install`ed, zero files scanned, a file it could not read), and `make lint` prints its green pass CONDITIONALLY on that. It used to print it unconditionally, over the top of `WARNING validate-structure could not run (nothing was checked)`, so a lint target that had checked nothing read as a clean one; the same `@echo` also masked `node --check` failures, which `find -exec` always exits 0 from (now piped through `xargs`). A directory or unreadable file in the source list is caught per file, so one bad entry no longer abandons the rest of the scan.

**`scripts/verify-pdf.js`'s LAST LINE has to carry the verdict, because its exit code cannot.** The design asked for `Overfull \vbox` to fail the build; it ships as a warning, since book-builder is shared and a check that breaks other books' builds gets switched off. That left a build with five fresh orphaned callout tails and a 40pt box hanging off a page ending on `No conformance errors, 6 warning(s)` — indistinguishable from six cosmetic warnings. The `notMeasured` caveat did not cover it either: that fires when a check did not RUN, not when a check ran and found the publisher's faults again. So `summaryLines()` (exported, unit-tested) names new class-1/class-2 findings with their pages, new class-3-5 findings, and a non-zero `Overfull \vbox` count, and the clean branch says in so many words that the warnings it counted are none of those. The exit code is deliberately unchanged.

---

**Document Owner**: Steve Atkinson
**Last Updated**: January 2, 2026
**Next Review**: After major feature additions or architecture changes
