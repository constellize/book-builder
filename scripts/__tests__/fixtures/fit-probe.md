---
title: "FIT probe"
---

<!--
RE-DERIVE THE CALLOUT HEIGHT CONSTANTS. Run this; do not re-guess them.

WHY THIS FILE EXISTS
--------------------
`templates/filters/callout-filter-print.lua` decides whether a callout is pinned
(`breakable=false`) by estimating its height from the constants in its `FIT` table. A pinned
box that does not fit does not warn and does not produce an `Overfull \vbox` -- it makes
xelatex spin forever shipping empty pages. So those constants are the inputs to a decision
whose wrong answer is an infinite build, and until this file they existed only as prose in
`memory-bank/systemPatterns.md`: produced once, by one implementer, and never falsified.

This probe measures THE FILTER'S OWN OUTPUT. Every box below is a real `::: info` /
`::: code` / promptref callout, written in markdown and wrapped in a `\setbox0=\vbox{...}` by
raw-LaTeX blocks on either side, so there is no second copy of the LaTeX to drift out of step
with the filter. The measurements go to the log with `\typeout`.

HOW TO RUN IT (from `book/`, the consuming book's root -- the defaults file's filter paths
are relative to it):

    mkdir -p build/intermediate
    pandoc book-builder/scripts/__tests__/fixtures/fit-probe.md \
      --defaults=book-builder/config/pandoc-defaults-print.yaml \
      --template=book-builder/templates/book-print.latex \
      --metadata=callout-pin-budget:433.6 \
      -o build/intermediate/fit-probe.tex
    xelatex -shell-escape -interaction=nonstopmode \
      -output-directory=build/intermediate build/intermediate/fit-probe.tex
    xelatex -shell-escape -interaction=nonstopmode \
      -output-directory=build/intermediate build/intermediate/fit-probe.tex
    grep FITPROBE build/intermediate/fit-probe.log

TWO xelatex PASSES ARE REQUIRED. minted writes its highlighted content to an auxiliary file
on the first pass and reads it back on the second, so on a single pass every code box measures
as though it were empty -- which is a believable number and a wrong one.

`--metadata=callout-pin-budget` is passed because that is what turns pinning on (the template
declares it; `build-book.js` forwards it). It matters here: the boxes measured below then come
out as `breakable=false`, which is the form a PINNED box actually takes, and the only form
whose height the estimator is answering a question about.

HOW TO READ THE OUTPUT. Every FIT constant is a DIFFERENCE of two measurements, never a
single one. The values below were measured on 2026-11-02 at the 6x9 trim with
`book-print.latex` and pandoc 3.8.3 / XeTeX; treat them as the reference run.

    textheight       542.025      info-1line    48.03351     code-1line   54.37428
    baselineskip      16.31996    info-2line    64.35347     code-21line 342.37325
    em                10.95       info-11line  211.23312
    note-absent       48.03351    title-11      90.7847      wrap-text  47.97 up to 58
    note-shorturl     69.2209     title-83     126.75342                 64.29 from 66
    note-longurl      80.2209     title-120    156.10834     wrap-code  54.37 up to 56
                                                                        68.52 from 64

    FIT.text_block 542.03  = textheight.
    FIT.text_line   16.32  = info-2line - info-1line = 16.31996, and the linearity check
                             (info-11line - info-1line) / 10 = 16.31996 exactly. This is
                             \baselineskip, which is what 11pt at linestretch 1.2 comes to.
    FIT.box         34.00  = info-1line - text_line = 31.71 measured. FIT HOLDS 34.00, which
                             is 2.3pt MORE than measured, on purpose: box + text_line (50.32)
                             must not come out under a real one-line box (48.03).
    FIT.code_pad     6.30  = (code-1line - code_line) - box = 5.97 against FIT's own 34.00
                             box. Read box and code_pad as a PAIR: what has to hold is
                             box + code_pad + N x code_line >= the real code box, and
                             40.30 + 14.40 = 54.70 against a measured 54.37 does.
    FIT.code_line   14.40  = (code-21line - code-1line) / 20 = 14.39995.
    FIT.note_base   10.00  } note-longurl  - note-absent = 32.19 = base + 2 x line (the URL
    FIT.note_line   11.00  } wraps to two lines), and note-shorturl - note-absent = 21.19
                             = base + 1 x line. 10 + 11 and 10 + 22 bracket both.
    FIT.em          11.00  = em measures 10.95 (Atkinson Hyperlegible at 11pt); FIT rounds up.
    FIT.text_chars    50   = the wrap-text ladder still sets 58 characters as one line and
                             wraps by 66. 50 is held BELOW that.
    FIT.code_chars    48   = the wrap-code ladder still sets 56 as one line and wraps by 64.
                             48 is held below that, because breaklines breaks at the last
                             break point BEFORE the measure and indents the continuation.

    FIT.title_line  18.00  = NOT cleanly isolated by this probe, and the one number that does
                             not reconcile. See the note below.

TITLE_LINE DOES NOT RECONCILE, AND THAT IS A RECORDED FINDING, NOT A BUG IN THE PROBE.
Only a promptref has a variable boxed title, and a promptref also repeats its title in the
`Link:` line of its body, so lengthening the title lengthens TWO things. The rendered PDF for
this run shows the 83-character title taking 2 boxed-title lines (so `title_chars` 42 is
right: 2 x 42 >= 83) and its `Link:` line taking 2 body lines. Backing the body line out of
the measured difference:

    (title-83 - title-11) - text_line = 35.97 - 16.32 = 19.65pt per extra boxed-title line

against `FIT.title_line = 18.00`. So the estimator is about 1.7pt LOW for each line a boxed
title wraps to. Bounded and not urgent: only promptref boxes wrap a title, no title in this
book reaches 3 lines, and the budget carries 110pt of headroom -- but it is LOW rather than
high, which is the direction that matters, and it should be corrected the next time the pin
count is allowed to move (changing it re-decides promptref boxes, which is a typeset change).
Recorded here rather than silently patched.

A number that disagrees with `FIT` in the LOW direction is the one to act on: the estimate may
run high (a box stays breakable: a few more split boxes) but never low (a box is pinned that
does not fit: xelatex never terminates). If the geometry, body font, leading or `\setminted`
changes, re-measure and update BOTH `FIT` and `\calloutPinBudget` in
`templates/book-print.latex` -- they all move together, so do not scale one and leave the rest.

THE CLIFF IS NOT PROBED HERE, ON PURPOSE -- SEE THE FOOT OF THIS FILE.
-->

# FIT probe

`\typeout{FITPROBE textheight = \the\textheight}`{=latex}
`\typeout{FITPROBE baselineskip = \the\baselineskip}`{=latex}
`\typeout{FITPROBE em = \the\dimexpr 1em\relax}\box0`{=latex}

## Body lines: box, and text_line

Written as LINE BLOCKS, not as separate paragraphs. `generateLatexCallout` renders a callout
body with one `pandoc.write` per block joined by a single newline, so two PARAGRAPHS come out
as ONE LaTeX paragraph and set as one line -- the estimator counts them separately and so runs
HIGH there, which is the safe direction and is not what these numbers are for. A line block is
the one construct whose source lines are reliably typeset lines.

`box` is `info-1line` less one `text_line`.

### 1 body line(s)

`\setbox0=\vbox{`{=latex}

::: info
| Line 1.
:::

`}\typeout{FITPROBE info-1line = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

### 2 body line(s)

`\setbox0=\vbox{`{=latex}

::: info
| Line 1.
| Line 2.
:::

`}\typeout{FITPROBE info-2line = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

### 11 body line(s)

`\setbox0=\vbox{`{=latex}

::: info
| Line 1.
| Line 2.
| Line 3.
| Line 4.
| Line 5.
| Line 6.
| Line 7.
| Line 8.
| Line 9.
| Line 10.
| Line 11.
:::

`}\typeout{FITPROBE info-11line = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

## A footnote inside a box: note_base and note_line

A footnote is set at the foot of the BOX, not the page (tcolorbox collects it there),
which is why pinning keeps a `Link:` line with the footnote it belongs to. The difference
between these and `note-absent` is `note_base` plus the footnote text's lines.

`\setbox0=\vbox{`{=latex}

::: info
| Line 1.
:::

`}\typeout{FITPROBE note-absent = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: info
| Line 1.[^u]
:::

[^u]: https://constellize.com/prompts/v1/revise-memory-bank-documentation-when-circumstances-change

`}\typeout{FITPROBE note-longurl = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: info
| Line 1.[^s]
:::

[^s]: https://constellize.com/p/x

`}\typeout{FITPROBE note-shorturl = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

## Boxed titles: title_line

Only a promptref has a variable boxed title (every other callout's title is a fixed
word), so these are promptref boxes and their absolute heights include the `Link:` line
and its footnote. Only the DIFFERENCES matter. COUNT THE TITLE LINES IN THE RENDERED PDF (every measured box is shipped to the page right
after it is measured, in file order, so the PDF is the visual record of what the log counted):
`title_line` is the difference divided by the number of extra lines the longer title
actually took, and `title_chars` must be held BELOW the width at which it wraps.

### A 11-character title

`\setbox0=\vbox{`{=latex}

::: {.promptref title="Short Title" url="https://constellize.com/p/x"}
| Line 1.
:::

`}\typeout{FITPROBE title-11 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

### A 83-character title

`\setbox0=\vbox{`{=latex}

::: {.promptref title="Implement Infrastructure Health Checks For Databases, Caches, APIs, And Filesystems" url="https://constellize.com/p/x"}
| Line 1.
:::

`}\typeout{FITPROBE title-83 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

### A 120-character title

`\setbox0=\vbox{`{=latex}

::: {.promptref title="Implement Infrastructure Health Checks For Databases, Caches, APIs, And Filesystems, Then Report On Each One Of Them Too" url="https://constellize.com/p/x"}
| Line 1.
:::

`}\typeout{FITPROBE title-120 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

## Code lines: code_line and code_pad

`code_line` is (`code-21line` - `code-1line`) / 20. `code_pad` is fancyvrb's own space
above and below a minted block: `code-1line` less `box` less one `code_line`. TWO xelatex
PASSES OR EVERY NUMBER HERE IS THE HEIGHT OF AN EMPTY BOX.

### 1 rendered code line(s)

`\setbox0=\vbox{`{=latex}

::: code

```json
{"a": 1}
```

:::

`}\typeout{FITPROBE code-1line = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

### 21 rendered code line(s)

`\setbox0=\vbox{`{=latex}

::: code

```json
{
  "k0": "v0",
  "k1": "v1",
  "k2": "v2",
  "k3": "v3",
  "k4": "v4",
  "k5": "v5",
  "k6": "v6",
  "k7": "v7",
  "k8": "v8",
  "k9": "v9",
  "k10": "v10",
  "k11": "v11",
  "k12": "v12",
  "k13": "v13",
  "k14": "v14",
  "k15": "v15",
  "k16": "v16",
  "k17": "v17",
  "k18": "v18",
}
```

:::

`}\typeout{FITPROBE code-21line = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

## Where a line starts to wrap: text_chars and code_chars

A LADDER, not a pair: read off the width at which the height jumps by one line, then keep
the constant in `FIT` BELOW it. The margin is not slack -- justification, and bold or
italic runs, set wider than the plain text measured here, and `breaklines` breaks a code
line at the last break point BEFORE the measure and indents the continuation under the
hook symbol, so a wrapped code line really gets fewer characters than fit geometrically.
Every string below is space-separated on purpose: a single unbreakable token does not
wrap at all, it runs into the margin, and measures as one line however long it is.

`\setbox0=\vbox{`{=latex}

::: info
| ab ab ab ab ab ab ab ab ab ab ab ab abxx
:::

`}\typeout{FITPROBE wrap-text-40 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: info
| ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab
:::

`}\typeout{FITPROBE wrap-text-50 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: info
| ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab abxx
:::

`}\typeout{FITPROBE wrap-text-58 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: info
| ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab abx
:::

`}\typeout{FITPROBE wrap-text-66 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: info
| ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab
:::

`}\typeout{FITPROBE wrap-text-74 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: code

```text
ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab abx
```

:::

`}\typeout{FITPROBE wrap-code-48 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: code

```text
ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab
```

:::

`}\typeout{FITPROBE wrap-code-56 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: code

```text
ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab abxx
```

:::

`}\typeout{FITPROBE wrap-code-64 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: code

```text
ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab abx
```

:::

`}\typeout{FITPROBE wrap-code-72 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

`\setbox0=\vbox{`{=latex}

::: code

```text
ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab ab
```

:::

`}\typeout{FITPROBE wrap-code-80 = \the\dimexpr\ht0+\dp0\relax}\box0`{=latex}

<!--
THE CLIFF: DELIBERATELY NOT PROBED, AND WHY
===========================================

The second load-bearing number is not a height, it is a threshold: at the 6x9 trim with
`book-print.latex`, a PINNED code callout of 35 rendered lines (approximately 544pt) typesets,
and one of 36 (approximately 558pt) NEVER TERMINATES. xelatex does not report an
`Overfull \vbox` and does not stop at `-halt-on-error`; it ships empty pages forever -- 139,000
of them before the original probe was killed. A build that never finishes writes no log, which
is why neither the `Overfull \vbox` check nor the fault detector can see this fault class at
all.

THERE IS NO SAFE AUTOMATED PROBE FOR IT, so there is no probe file for it, and nothing in
`npm test` or `npm run test:unit` goes near it. A committed probe that hangs would be run by
somebody who did not read this, in CI or on a laptop, and it does not stop.

RE-DERIVING IT IS A DELIBERATE, SUPERVISED ACT. It takes minutes, it must be run in a terminal
you are watching, and YOU WILL HAVE TO KILL IT. The exact procedure:

  1. Make a scratch copy of the manuscript somewhere outside the repository. Do NOT run this
     against `book/`: it writes a partial PDF and a log of unbounded size.

  2. Put a single code callout of N rendered lines in a chapter, with nothing else on the page,
     and force it to be pinned. The content that produced the measurement above was a JSON
     listing of N short lines, exactly like the `code-21line` box above scaled up -- each line
     short enough to render as ONE typeset line, verified in the PDF, not assumed.

  3. Build the print target and WATCH IT. A build that is past the cliff announces itself: the
     page count in the terminal climbs without bound and the output file grows steadily. Kill
     it (Ctrl-C, and check for an orphaned xelatex with `pgrep xelatex`) as soon as the page
     count passes the book's real extent by a few hundred.

  4. Bisect N by hand. A build that terminates and produces a sane page count is below the
     cliff; one you had to kill is above it. 35 and 36 were the last pair.

  5. Convert to points with the `code_line` and `box` constants measured above
     (`box + code_pad + N x code_line`), and check that `FIT.fraction` still leaves a margin
     you would defend: 0.80 x 542.03 = 433.6pt against a 544pt cliff is 110pt of headroom, and
     the tallest box this book actually pins estimates at 429pt.

If you are tempted to automate step 3 with a timeout: the useful signal is not "it took too
long", it is "it was still going when the page count was absurd", and the cliff moves with the
template. A number this expensive to get wrong is worth an afternoon of somebody's attention.
-->
