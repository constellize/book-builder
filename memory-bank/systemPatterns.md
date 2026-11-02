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

**How every constant was measured** (probe: a markdown file of `{=latex}` blocks run through
`pandoc-defaults-print.yaml` and `book-print.latex`, each quantity captured with
`\setbox0=\vbox{...}\typeout{\the\ht0}`; minted needs two xelatex passes before its content
exists, or every code box measures as empty):

| Constant | pt | Derivation |
| --- | --- | --- |
| `text_block` | 542.03 | `\the\textheight`: 9in paper less 0.75in top and bottom |
| `box` | 34.00 | info box with 1 body line (50.00) less one body line |
| `title_line` | 18.00 | 83-character title (67.97) less 11-character title (49.96) |
| `title_chars` | 42 | an 83-char title takes 2 lines, a 122-char title 3; held back from the ~56 the 0.82\linewidth measure allows |
| `text_line` | 16.32 | info box 2 paragraphs (66.32) less 1 paragraph (50.00); linear to 11 paragraphs (213.20) |
| `text_chars` | 50 | 58 characters still set as one line, 60 wrapped; held back for justification and bold/italic runs |
| `code_line` | 14.40 | code box 21 minted lines (342.37) less 1 line (54.37), over 20 |
| `code_chars` | 48 | the geometric measure takes 56 (56 chars fit, 58 overfull by 6.1pt), but breaklines breaks at the last break point BEFORE the measure and indents the continuation under the hook symbol: the book's own 62-char line broke after 49 |
| `code_pad` | 6.30 | code box overhead (39.97) less text box overhead (34.00) |
| `note_base`, `note_line`, `note_chars` | 10.00, 11.00, 40 | promptref box with a long-URL footnote (101.28) less the same without one (69.28) = 32pt = rule+skip plus 2 lines; a short URL costs 21pt = rule+skip plus 1 line |
| `em` | 11.00 | the body font size, for the promptref box's `\vspace{0.3em}` and `\vspace{0.5em}` |

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

**Known interaction, NOT fixed: a callout containing its own lead-in can never be pinned.**
`keep-leadin-with-content.lua` runs first and walks into callout `Div`s on purpose, so it
inserts its `\needspace` RawBlock into the box's own content; `estimate_block()` sees an
unrecognised LaTeX RawBlock and answers nil. That fails safe, but it means fault B can quietly
return for any callout that gains a sentence ending in a colon, with nothing in the page or
the test suite to say why that box behaved differently. Written up in the filter at the foot
of `estimate_block()`.

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

`\clubpenalty=10000` forbids leaving a paragraph's first line alone at a page foot, but it acts on a line break inside a paragraph. A one-line paragraph has no line break to penalise, so any paragraph that is only one line long (a standalone bold label, say) is strandable by construction, whatever the penalties are set to. What matters is the length of the whole paragraph, not the lead: a run-in bold lead followed by prose is only at risk if the entire paragraph fits on one line. This is why the fix for stranded labels (e.g. `**Day 1: ...**` alone at a page foot) is to fold them into the paragraph they introduce rather than to add keep-with-next machinery. `scripts/validate-structure.js` (`npm run validate:structure`, run by `make lint`) finds such bold-only blocks in source. It reports a warning and exits 0 by design: such labels are often legitimate, and this builder is shared, so a failing check would be switched off.

---

**Document Owner**: Steve Atkinson
**Last Updated**: January 2, 2026
**Next Review**: After major feature additions or architecture changes
