#!/bin/bash
# Generate PLACEHOLDER covers: front and back at the publisher's press trim, plus a clean
# ebook cover.
#
# These exist so the EPUB can declare a cover and the page proof has something in the right
# shape. They are deliberately, visibly not final art -- real covers come from the
# publisher's design team.
#
# Built through XeLaTeX rather than ImageMagick because IM here has no Freetype delegate and
# cannot use the Atkinson Hyperlegible brand fonts; LaTeX already has them working.
set -euo pipefail
export PATH="/usr/local/texlive/2025/bin/universal-darwin:$PATH"

BOOK="$(cd "$(dirname "$0")/../.." && pwd)"
FONTS="$BOOK/book-builder/fonts/"
OUT="$BOOK/images/cover"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# $1 name  $2 heading  $3 body  $4 guides(yes|no)
gen() {
  local name="$1" heading="$2" body="$3" guides="$4"
  local guide_tex="" spec_tex=""
  if [ "$guides" = yes ]; then
    # Press covers carry trim and safety marks; an ebook cover with trim marks on it just
    # looks unfinished, so they are optional.
    guide_tex='\draw[guide,dashed,line width=0.4pt] ($(current page.south west)+(0.125in,0.125in)$) rectangle ($(current page.north east)+(-0.125in,-0.125in)$);
  \draw[guide!50,dotted,line width=0.4pt] ($(current page.south west)+(0.375in,0.375in)$) rectangle ($(current page.north east)+(-0.375in,-0.375in)$);'
    spec_tex='\node[white!45,font=\tiny,align=center] at ($(current page.south)+(0,0.6in)$) {6\,$\times$\,9in trim \quad 0.125in bleed \quad 0.25in safety \quad 300\,dpi\\ dashed = trim \quad dotted = safety};'
  fi

  cat > "$WORK/$name.tex" <<EOF
\\documentclass[12pt]{article}
\\usepackage[paperwidth=6.25in,paperheight=9.25in,margin=0in]{geometry}
\\usepackage{fontspec}
\\usepackage{xcolor}
\\usepackage{tikz}
\\usetikzlibrary{calc}   % required for the \$(a)+(b)\$ coordinate arithmetic below
\\setmainfont{AtkinsonHyperlegibleNext-Regular.ttf}[
  Path = $FONTS,
  BoldFont = AtkinsonHyperlegibleNext-Bold.ttf,
  ItalicFont = AtkinsonHyperlegibleNext-RegularItalic.ttf]
\\definecolor{ink}{HTML}{1E2430}
\\definecolor{accent}{HTML}{208479}
\\definecolor{guide}{HTML}{C83737}
\\pagestyle{empty}
\\begin{document}
\\begin{tikzpicture}[remember picture,overlay]
  \\fill[ink] (current page.south west) rectangle (current page.north east);
  $guide_tex
  \\node[white,font=\\bfseries\\Large,align=center,text width=4.2in]
    at (\$(current page.center)+(0,2.2in)\$) {$heading};
  \\node[white!85,align=center,text width=4.2in,font=\\small]
    at (\$(current page.center)+(0,0.2in)\$) {$body};
  \\node[accent,font=\\bfseries\\small] at (\$(current page.center)+(0,-2.6in)\$)
    {PLACEHOLDER -- NOT FINAL ART};
  $spec_tex
\\end{tikzpicture}
\\end{document}
EOF

  # TWICE, deliberately: tikz `remember picture, overlay` resolves page-relative coordinates
  # from the .aux file, so a single pass puts every node at the origin and the page comes
  # out blank with the text piled in one corner.
  (cd "$WORK" && xelatex -interaction=nonstopmode "$name.tex" >/dev/null 2>&1) || true
  (cd "$WORK" && xelatex -interaction=nonstopmode "$name.tex" >/dev/null 2>&1) || true
  [ -f "$WORK/$name.pdf" ] || { echo "  FAILED to build $name"; return 1; }
  cp "$WORK/$name.pdf" "$OUT/$name.pdf"
  magick -density 300 "$WORK/$name.pdf" -background white -alpha remove -alpha off "$OUT/$name.png"
  # `identify` reports these as "118.11 PixelsPerCentimeter" -- that is display formatting,
  # not a defect: PNG's pHYs chunk only stores pixels-per-metre, and 11811 px/m is 300 dpi.
  echo "  $name: $(magick identify -format '%wx%h' "$OUT/$name.png")"
}

gen "front-cover-placeholder" \
    "The Constellize Method\\\\[2mm]{\\normalsize\\mdseries Building Software Systems from Knowledge}" \
    "Steve Atkinson" yes

gen "back-cover-placeholder" \
    "{\\normalsize Back cover}" \
    "Blurb goes here.\\\\[4mm]Reserve the lower right for the ISBN barcode: 2\\,\$\\times\$\\,1.2in, clear of the safety margin." yes

# Ebook cover: no press marks. Amazon's guideline is 1600x2560 portrait; the publisher's
# note said 2560x1600, which is landscape and almost certainly a transposition for a 6x9
# book. Flagged to them rather than silently followed.
gen "ebook-cover-placeholder" \
    "The Constellize Method\\\\[2mm]{\\normalsize\\mdseries Building Software Systems from Knowledge}" \
    "Steve Atkinson" no
magick -density 300 "$OUT/ebook-cover-placeholder.pdf" -background white -alpha remove \
       -resize 1600x2560^ -gravity center -extent 1600x2560 "$OUT/epub-cover-placeholder.png"
echo "  epub-cover-placeholder: $(magick identify -format '%wx%h' "$OUT/epub-cover-placeholder.png")"
