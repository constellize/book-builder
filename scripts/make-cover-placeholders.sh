#!/bin/bash
# Generate PLACEHOLDER front and back covers at the publisher's trim, plus an EPUB cover.
#
# These exist so the EPUB can declare a cover and the page proof has something in the
# right shape -- they are deliberately, visibly not final art. Real covers come from the
# publisher's design team.
#
# Built through XeLaTeX rather than ImageMagick because IM here has no Freetype delegate
# and cannot use the Atkinson Hyperlegible brand fonts; LaTeX already has them working.
set -euo pipefail
export PATH="/usr/local/texlive/2025/bin/universal-darwin:$PATH"

BOOK="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$BOOK/images/cover"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# 6x9in trim. Bleed 0.125in per the spec, applied only because a cover does bleed even
# when the interior does not -- background art runs to the edge by definition.
gen() {  # $1=name  $2=heading  $3=body
  cat > "$WORK/$1.tex" <<EOF
\\documentclass[12pt]{article}
\\usepackage[paperwidth=6.25in,paperheight=9.25in,margin=0in]{geometry}
\\usepackage{fontspec}
\\usepackage{xcolor}
\\usepackage{tikz}
\\usetikzlibrary{calc}  % required for the \$(a)+(b)\$ coordinate arithmetic below
\\setmainfont{AtkinsonHyperlegibleNext-Regular.ttf}[
  Path = $BOOK/book-builder/fonts/,
  BoldFont = AtkinsonHyperlegibleNext-Bold.ttf,
  ItalicFont = AtkinsonHyperlegibleNext-RegularItalic.ttf]
\\definecolor{ink}{HTML}{1E2430}
\\definecolor{accent}{HTML}{208479}
\\definecolor{guide}{HTML}{C83737}
\\pagestyle{empty}
\\begin{document}
\\begin{tikzpicture}[remember picture,overlay]
  % full bleed ground
  \\fill[ink] (current page.south west) rectangle (current page.north east);
  % trim box: 0.125in inside the bleed edge
  \\draw[guide,dashed,line width=0.4pt]
    (\$(current page.south west)+(0.125in,0.125in)\$) rectangle
    (\$(current page.north east)+(-0.125in,-0.125in)\$);
  % safety margin: a further 0.25in in
  \\draw[guide!50,dotted,line width=0.4pt]
    (\$(current page.south west)+(0.375in,0.375in)\$) rectangle
    (\$(current page.north east)+(-0.375in,-0.375in)\$);
  \\node[white,font=\\bfseries\\Large,align=center,text width=4.2in]
    at (\$(current page.center)+(0,2.2in)\$) {$2};
  \\node[white!85,align=center,text width=4.2in,font=\\small]
    at (\$(current page.center)+(0,0.2in)\$) {$3};
  \\node[accent,font=\\bfseries\\small] at (\$(current page.center)+(0,-2.6in)\$)
    {PLACEHOLDER -- NOT FINAL ART};
  \\node[white!45,font=\\tiny,align=center] at (\$(current page.south)+(0,0.6in)\$)
    {6\\,\$\\times\$\\,9in trim \\quad 0.125in bleed \\quad 0.25in safety \\quad 300\\,dpi\\\\
     dashed = trim \\quad dotted = safety};
\\end{tikzpicture}
\\end{document}
EOF
  # TWICE, deliberately: tikz `remember picture, overlay` resolves page-relative
  # coordinates from the .aux file, so on a single pass every node lands at the origin
  # and the page comes out blank with the text piled in one corner.
  (cd "$WORK" && xelatex -interaction=nonstopmode "$1.tex" >/dev/null 2>&1) || true
  (cd "$WORK" && xelatex -interaction=nonstopmode "$1.tex" >/dev/null 2>&1) || true
  [ -f "$WORK/$1.pdf" ] || { echo "  FAILED to build $1"; return 1; }
  cp "$WORK/$1.pdf" "$OUT/$1.pdf"
  magick -density 300 "$WORK/$1.pdf" -background white -alpha remove -alpha off "$OUT/$1.png"
  # Restate the density on write. Note that `identify` reports these as "118.11
  # PixelsPerCentimeter" -- that is display formatting, not a defect: PNG's pHYs chunk
  # only stores pixels-per-metre, and 11811 px/m is exactly 300 dpi.
  magick "$OUT/$1.png" -density 300 -units PixelsPerInch "$OUT/$1.png"
  echo "  $1: $(magick identify -format '%wx%h @%x dpi' "$OUT/$1.png")"
}

gen "front-cover-placeholder" \
    "The Constellize Method\\\\[2mm]{\\normalsize\\mdseries Building Software Systems from Knowledge}" \
    "Steve Atkinson"

gen "back-cover-placeholder" \
    "{\\normalsize Back cover}" \
    "Blurb goes here.\\\\[4mm]Reserve the lower right for the ISBN barcode: 2\\,\$\\times\$\\,1.2in, clear of the safety margin."

# EPUB in-book cover. Amazon's guideline is 1600x2560 portrait; the spec note said
# 2560x1600, which is landscape and almost certainly a transposition for a 6x9 book.
magick -density 300 "$OUT/front-cover-placeholder.pdf" -background white -alpha remove \
       -resize 1600x2560^ -gravity center -extent 1600x2560 "$OUT/epub-cover-placeholder.png"
magick "$OUT/epub-cover-placeholder.png" -density 300 -units PixelsPerInch "$OUT/epub-cover-placeholder.png"
echo "  epub-cover-placeholder: $(magick identify -format '%wx%h @%x dpi' "$OUT/epub-cover-placeholder.png")"
