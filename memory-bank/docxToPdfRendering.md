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
| `-e, --engine` | `libreoffice` (default) \| `word` \| `both` |
| `-o, --out` | a `.pdf` path or a directory. Default: beside the input. |
| `--png [N]` | also rasterise page N (1-based) next to each PDF |
| `--density` | dpi for `--png`, default 130 |
| `--timeout` | per-engine seconds, default 180 |
| `--no-word-pref-toggle` | never touch a Word preference; report instead |

Implementation and the full reasoning: `scripts/lib/docx-render.js`.
`BOOK_BUILDER_SOFFICE` overrides the LibreOffice binary path (CI, Linux).

## Which engine

**LibreOffice is the default** and the one to reach for in the build loop: no
sandbox, ~0.8 s, works from any directory, works headless in CI, and it touches
nothing on the machine.

**Word is the fidelity reference**, ~1.5 s warm / ~2.6 s cold. Reach for it when
a Word-specific behaviour is the thing under test, and always for anything with
a live `{ TOC }` field, because that is the one real difference:

> LibreOffice does not update field results on import. A pandoc `--toc` document
> renders with the *heading* "Table of Contents" and nothing under it — measured
> 0 dot-leader lines vs Word's 6. `--engine both` prints that difference and
> labels it, so it is not mistaken for a styling regression.

`--engine both` renders with each and prints a comparison table (time, size,
pages, TOC lines, embedded font families). That is the fidelity check: fast loop
in LibreOffice, confirm in Word.

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

The original value is journalled to
`~/Library/Application Support/book-builder/word-pref-journal.json` *before* the
flip. If a run is killed mid-flight, the next run finds the journal and restores
the setting, and says so. **Your preference is never left changed.** If you would
rather it were never touched at all, pass `--no-word-pref-toggle`: the script
then detects the prompting condition and tells you the one thing to change
(`Word > Settings > General > 'Update automatic links at open'`) instead of
hanging on a modal.

**"Word would like to access files in ..."** is the App Sandbox powerbox, not
TCC. Word ships with `com.apple.security.app-sandbox` and only
`files.user-selected.read-write`, so *every* path outside
`~/Library/Containers/com.microsoft.Word/Data/` needs an interactive grant —
`build/` no differently from `/private/tmp`. Full Disk Access does not help:
FDA is TCC, and App Sandbox is enforced independently of it.

So the script stages both the input and the output inside Word's own container
and moves the PDF across the boundary itself. **No permission change is needed,
and none should be granted.** Your `-o` path can be anywhere.

## Verified on this machine (2026-09-02, Word 16.112.3, LibreOffice 26.8.0.3)

Detector: a powerbox panel runs as a child process of Word, so
`ps -axo pid=,ppid=,comm=` filtered on `openAndSavePanelService` with
`ppid == Word` catches prompt B; prompt A shows up as the run simply blocking.

- 5/5 consecutive Word runs with the preference left ON in between — 1.50–1.79 s,
  byte-identical 66688-byte PDFs, 6 TOC entries every time, zero prompt events.
- 1 cold start with Word fully quit — 2.60 s, same bytes, same TOC.
- Output written to a never-granted directory under `/private/tmp` — clean.
- A user's document open in Word at the same time — untouched. The script targets
  its own staged document *by name*, never `active document`.
- `reference-digital.docx` through `--engine both`: 2 pages from each engine, the
  same four Atkinson faces embedded, no substituted fonts.

Failure paths exercised deliberately: missing input, non-`.docx` input, unknown
engine, missing LibreOffice, `soffice` exiting 0 with no output, `soffice`
hanging past the timeout, Word timing out mid-conversion (preference restored,
staged document closed, journal cleared), and a simulated crashed run (journal
replayed on the next start).

## Gotchas worth remembering

- `pdffonts` showing `ArialMT` in a Word render is **not** a failure. It is the
  invisible tab between a list marker and its text (subset `FirstChar =
  LastChar = 33`, one glyph, width 278). It renders nothing and cannot be
  removed via `numbering.xml`.
- LibreOffice happily "converts" garbage: 4 KB of `/dev/urandom` named `.docx`
  produced a 136 KB PDF. A non-empty PDF is not proof the input was valid.
- Word's owner file is `~$` plus the name with its **first two characters
  dropped** (`bb-123.docx` -> `~$-123.docx`), which is why staged cleanup
  matches on the tag's tail rather than a `~$<name>` guess.
- Word's `open` returns no Apple event result despite its sdef; `set d to open
  ...` leaves `d` undefined and the next line dies with `-2753`.
- `repeat with d in (every document)` fails with "every document doesn't
  understand the count message"; use a reverse index loop.

## If you want an npm script

Not added here, to keep this change to new files only. The obvious one:

```json
"docx:pdf": "node scripts/docx-to-pdf.js"
```
