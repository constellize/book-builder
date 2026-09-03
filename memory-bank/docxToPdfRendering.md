# docx -> PDF rendering (operator note)

Rendering a `.docx` to PDF used to mean sitting through two macOS prompts on
every attempt. It does not any more. Use the script.

```bash
node scripts/docx-to-pdf.js templates/docx/reference-digital.docx
node scripts/docx-to-pdf.js some.docx --engine both --png 1 -o /tmp/check/
node scripts/docx-to-pdf.js some.docx --engine word -o build/tmp/preview.pdf
```

| flag | meaning |
|---|---|
| `-e, --engine` | `auto` (default) \| `libreoffice` \| `word` \| `both` |
| `-o, --out` | a `.pdf` path or a directory. Default: beside the input. |
| `--png [N]` | also rasterise page N (1-based) next to each PDF |
| `--density` | dpi for `--png`, default 130 |
| `--timeout` | per-engine seconds, default 180 |
| `--no-word-pref-toggle` | never touch a Word preference; report instead |

Implementation and the full reasoning: `scripts/lib/docx-render.js`.
`BOOK_BUILDER_SOFFICE` overrides the LibreOffice binary path (CI, Linux);
`BOOK_BUILDER_WORD_APP` overrides Word's, and pointing it at a nonexistent path
is how the "no Word installed" path gets exercised on a machine that has Word.

## Which engine — and why the script now decides

**The default is `auto`, and it is not a convenience.** The two engines disagree
about page parity, and the disagreement is invisible in the output.

> LibreOffice DROPS the implicit blank verso that a `w:type="oddPage"` section
> break requires. Word inserts it; LibreOffice just starts the next section on
> the next physical sheet.

Measured on a six-chapter document carrying the six paragraph-level `oddPage`
sections that `scripts/lib/docx-postprocess.js` inserts:

| engine | pages | blank versos | chapter openers land on physical |
|---|---|---|---|
| LibreOffice | 25 | 0 | 2, 7, 10, 16, 18, 23 — **four on a verso** |
| Word | 29 | 4 (p2, p8, p12, p26) | 3, 9, 13, 19, 21, 27 — all recto |

The openers are only the symptom. From the first dropped blank onward *every*
physical sheet has the wrong parity, so the mirrored margins bind on the wrong
edge and the running heads swap sides. Directly measured: LibreOffice's physical
page 2 — a verso — carries the **recto** header layout (title left, folio right)
and prints folio "3" on the second sheet. LibreOffice also ignores `w:titlePg`
on the cloned sections, so it draws a running head on chapter-opening pages that
Word correctly leaves blank.

**The logical page numbers stay correct throughout.** That is what made this
dangerous: the `.docx` is right in Word's model, the PDF looks like a book, and
nothing in it announces that it is not a print proof. Anyone checking openright
with the old default command would have been checking it against a lie.

So:

- `auto` reads `word/document.xml`. Mid-document open-right breaks -> **Word**.
  Anything else -> **LibreOffice**, unchanged fast path.
- `--engine libreoffice` still does exactly what it says, still exits 0, and is
  still the CI engine. On an open-right document it now prints a red
  `THIS PDF IS NOT A VALID PRINT PROOF` banner before *and* after the render,
  with the measured blank-verso count next to it.
- No Word installed and `auto` wanted it? Falls back to LibreOffice with the same
  banner rather than failing. CI on Linux keeps working.
- `--engine both` prints a `PARITY:` line quantifying the gap, e.g.
  *LibreOffice is 4 pages short (25 vs 29). Word inserted blank versos at
  2, 8, 12, 26; LibreOffice inserted 0.*

### The discriminator is the document, never the filename

`docxLayoutInfo()` counts paragraph-level `<w:sectPr>` elements whose `w:type` is
`oddPage`/`evenPage`. Measured: `reference-{digital,print}.docx` have **0**
(one body-level sectPr, whose `oddPage` fires at document start where no implicit
blank is possible — so LibreOffice cannot get them wrong, and they keep the
0.85 s path). A built book has **6**.

A filename heuristic would have been wrong: **`reference-digital.docx` is
open-right with a 288-twip binding gutter and mirrored margins too** — both
variants share `sectionType` and `gutter` in `config/docx-styles.js`. "print" in
the name is neither necessary nor sufficient.

### The other engine difference, unchanged

> LibreOffice does not update field results on import. A pandoc `--toc` document
> renders with the *heading* "Table of Contents" and nothing under it — measured
> 0 dot-leader lines vs Word's 6. `--engine both` prints that difference and
> labels it, so it is not mistaken for a styling regression.

LibreOffice output is still perfectly good for text, styling, font-embedding and
layout-within-a-page checks. It is only page *parity* and *fields* it gets wrong.

## Word PDFs are size-identical, NOT byte-identical

Same input, same Word, same machine, back to back:

| | bytes | md5 | pages | sha256 of extracted text |
|---|---|---|---|---|
| run 1 | 96680 | e2d6ac48… | 29 | d421cd6b… |
| run 2 | 96680 | 585274aa… | 29 | d421cd6b… |
| run 3 | 96680 | 48e5e4d0… | 29 | d421cd6b… |

The differing bytes are `/CreationDate`, `/ModDate` and the trailer `/ID` —
62 bytes at two sites on that document, 64 on `reference-print.docx` (which is
size-stable at 83911 bytes across runs). The count is document-dependent; the
*cause* is not.

**A CI check written against byte-identity will flap.** Use
`render.pdfTextFingerprint(pdf)` instead — `{ pages, sha256, bytes }`, where the
sha256 is over `pdftotext` output. Page count and text hash were identical across
every run above. This corrects an earlier note here that claimed "byte-identical
66688-byte PDFs"; they were size-identical, not byte-identical.

## What a Word run leaves on the machine

The **"update automatic links at open" preference is genuinely restored.** It is
journalled to
`~/Library/Application Support/book-builder/word-pref-journal.json` *before* the
flip and put back in a `finally`; if a run is killed mid-flight the next run
finds the journal, restores the setting and says so. That happened for real
during this verification — a run killed by SIGPIPE left it off, and the next run
reported *"recovered: a previous run left … off; restored to ON"*. Final state
checked: journal gone, preference `true`.

**But the run is not side-effect free**, and this note used to imply it was.
Rendering opens a real Word window, and Word remembers where it was:

```
defaults read com.microsoft.Word "NSWindow Frame WDDocumentWindowFrameNameDefault"
```

moves. Measured: seeded with `100 100 800 600 0 0 1920 1050`, one render left
`394 421 800 600 0 0 1920 1050`. Nothing else under `com.microsoft.Word` changed
— `defaults read com.microsoft.Word` diffed clean across three runs otherwise.
It is cosmetic (remembered document-window geometry) and there is nothing to do
about it short of not using Word, but **do not claim the machine is untouched.**

## Why there are no prompts any more

Two separate mechanisms, two separate defences. Both are documented at length in
the header of `scripts/lib/docx-render.js`; the short version:

**"Fields that may refer to other files"** comes from Word's *Update automatic
links at open* preference being ON (the default) while the document has a field.
Nothing else suppresses it — not `display alerts`, not a UI-scripting watcher
(Word exposes zero AX windows while blocked), not `defaults write` (the setting
lives in the Office registration SQLite DB, not a plist). The script turns the
preference off for the duration, updates the fields explicitly instead — so the
TOC is still correct — and puts the preference back.

If you would rather it were never touched at all, pass `--no-word-pref-toggle`:
the script then detects the prompting condition and tells you the one thing to
change (`Word > Settings > General > 'Update automatic links at open'`) instead
of hanging on a modal. A document with no fields at all (a plain pandoc
conversion with no `--toc`) is rendered without touching the preference either
way, and says `preference left alone`.

**"Word would like to access files in ..."** is the App Sandbox powerbox, not
TCC. Word ships with `com.apple.security.app-sandbox` and only
`files.user-selected.read-write`, so *every* path outside
`~/Library/Containers/com.microsoft.Word/Data/` needs an interactive grant —
`build/` no differently from `/private/tmp`. Full Disk Access does not help:
FDA is TCC, and App Sandbox is enforced independently of it.

So the script stages both the input and the output inside Word's own container
and moves the PDF across the boundary itself. **No permission change is needed,
and none should be granted.** Your `-o` path can be anywhere.

## Verified on this machine (2026-09-03, Word 16.112.3, LibreOffice 26.8.0.3)

Every engine path, on a six-chapter open-right fixture built with
`reference-print.docx` + `postProcessDocx`:

| command | engine chosen | time | result |
|---|---|---|---|
| *(plain default)* | Word | 1.96 s | 29 pp, 4 blank versos, **6/6 chapters on a recto** |
| `--engine libreoffice` | LibreOffice | 1.06 s | 25 pp, 0 blanks, banner ×2, exit 0 |
| `--engine both` | both | 3.1 s | comparison table + `PARITY: LibreOffice is 4 pages short` |
| `BOOK_BUILDER_WORD_APP=/nonexistent` | LibreOffice | 1.05 s | banner, `Fix: render on a machine with Word`, exit 0 |
| *(default)* on `reference-digital.docx` | LibreOffice | 0.84 s | fast path preserved |
| *(default)* on `reference-print.docx` | LibreOffice | 0.86 s | fast path preserved |
| *(default)* on the **digital**-variant book | Word | 1.82 s | proves the choice is not a filename heuristic |
| `--engine word` on `reference-digital.docx` | Word | 1.63 s | unchanged |
| `--png 3` through `auto` | Word | 2.0 s | PNG written |

Bad usage still exits 2 (unknown engine / missing input / non-`.docx`), and
`--engine` now lists `auto | libreoffice | word | both`.

`scripts/verify-docx.js` is unaffected: it always passes an explicit `--engine`
(only ever `word` or `libreoffice`), and single-engine output is still written as
`<stem>.pdf`. Both of its invocation shapes were re-run against the new script
and produced the same filename and exit code as before.

Earlier verification, still standing: 5/5 consecutive Word runs prompt-free with
the preference left ON in between (1.50–1.79 s), one cold start with Word fully
quit (2.60 s), output to a never-granted `/private/tmp` directory, a user's own
document open in Word at the same time left untouched, and the deliberate failure
paths (missing input, non-`.docx`, unknown engine, missing LibreOffice, `soffice`
exiting 0 with no output, `soffice` hanging past the timeout, Word timing out
mid-conversion, a simulated crashed run replayed from the journal).

## Gotchas worth remembering

- **A killed run can wedge the next two Word renders.** Piping this script into
  `head` is enough: SIGPIPE kills it before its own cleanup, leaving
  `bb-<pid>-….docx` and Word's `~$-<pid>-….docx` owner file in
  `~/Library/Containers/com.microsoft.Word/Data/Documents/.book-builder-stage/`.
  Word then tries to recover them and `document "<tag>"` resolves to nothing —
  observed as `Connection is invalid (-609)` and then `missing value doesn't
  understand the "repaginate" message (-1708)`. `renderWord` now sweeps the stage
  on entry, removing only entries whose embedded pid is **dead and not ours**, so
  concurrent renders in other processes are never touched. Verified: a dead-pid
  pair removed, a live sibling's file and an unrelated file both preserved.
- **Concurrent Word renders share one preference and one journal.** The
  preference is global to Word and `PREF_JOURNAL` is a single fixed path with no
  locking, so two renders running at once can interleave: B reads the preference
  while A has it flipped, decides its "original" is OFF, and has nothing to
  restore — or B's recovery consumes A's journal. Observed during this session:
  after a batch of overlapping runs the preference was left OFF with no journal
  on disk. Nothing here corrupts a document, but if you run renders in parallel,
  check
  `osascript -e 'tell application "Microsoft Word" to return (update links at
  open of settings) as string'`
  afterwards. One render at a time is self-healing; several are not.
- `pdffonts` showing `ArialMT` in a Word render is **not** a failure. It is the
  invisible tab between a list marker and its text (subset `FirstChar =
  LastChar = 33`, one glyph, width 278). It renders nothing and cannot be
  removed via `numbering.xml`.
- LibreOffice happily "converts" garbage: 4 KB of `/dev/urandom` named `.docx`
  produced a 136 KB PDF. A non-empty PDF is not proof the input was valid.
- Blank pages are evidence, not a detector. `pdfBlankPages()` returning `[]` on an
  open-right document is suspicious but not proof of failure — a document may
  genuinely never need a blank verso. That is why the warning keys off the
  engine, and prints the blank count beside it as corroboration.
- Word's owner file is `~$` plus the name with its **first two characters
  dropped** (`bb-123.docx` -> `~$-123.docx`), which is why staged cleanup and the
  stale sweep match on the tag's tail / embedded pid rather than a `~$<name>`
  guess.
- Word's `open` returns no Apple event result despite its sdef; `set d to open
  ...` leaves `d` undefined and the next line dies with `-2753`.
- `repeat with d in (every document)` fails with "every document doesn't
  understand the count message"; use a reverse index loop.

## If you want an npm script

Not added here, to keep this change to new files only. The obvious one:

```json
"docx:pdf": "node scripts/docx-to-pdf.js"
```
