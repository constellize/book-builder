/**
 * Light-theme colour remap for the Excalidraw diagram sources.
 *
 * WHY
 * ---
 * All 61 sources use viewBackgroundColor #0B1020 -- a near-black navy. On screen that is
 * deliberate and looks good. In print each diagram becomes a full-width solid dark
 * rectangle: measured 289-294% total ink against the publisher's 240% limit, plus
 * show-through onto the reverse of the leaf. No separation strategy fixes a solid dark
 * background, so the artwork itself has to change.
 *
 * NOT JUST A BACKGROUND FLIP
 * --------------------------
 * The accent colours were chosen FOR a dark ground, so they are light and low-contrast on
 * white: teal #54D6C7 is 1.78:1, blue #7AA2FF 2.49:1, amber #FFB020 1.83:1. Flipping only
 * the background would trade "unreadably dark" for "unreadably pale". Each accent is
 * therefore replaced by a same-hue, same-saturation colour darkened until it reaches WCAG
 * AA (4.5:1) on white -- computed, not eyeballed, and recorded here so the next person can
 * see the reasoning rather than a table of magic hexes.
 *
 * Translucent fills carry an 8-digit form (#54D6C715); the alpha suffix is preserved.
 */

// base -> light-theme replacement, with the measured contrast on white
const MAP = {
  '#0B1020': '#FFFFFF', //  ground: near-black navy -> white
  '#EAF0FF': '#1E2430', //  1.14:1 -> 15.55:1   primary text and strokes
  '#ffffff': '#1E2430', //  1.00:1 -> 15.55:1   white strokes
  '#FFFFFF': '#1E2430',
  '#54D6C7': '#208479', //  1.78:1 ->  4.53:1   teal
  '#7AA2FF': '#2B6BFF', //  2.49:1 ->  4.52:1   blue
  '#FFB020': '#A46A00', //  1.83:1 ->  4.53:1   amber
  '#FF9020': '#9A5A00', //  amber variant, same treatment
  '#FF5C7A': '#D11A3C', //  2.97:1 ->  4.5:1    rose, pulled back from the computed
                        //                      #EC002B which was too hot for CMYK
  '#7A8A99': '#687887', //  3.55:1 ->  4.54:1   grey
  '#888888': '#767676', //  3.54:1 ->  4.54:1   grey
  // #666666 already clears AA at 5.74:1 and is left alone.

  // --- Panel fills -------------------------------------------------------------------
  // These sixteen were missed by the first pass, which only covered the six documented
  // palette colours. They are dark surfaces that sat just ABOVE a near-black ground, so
  // darkening them is wrong -- they have to be inverted in lightness, to sit just BELOW
  // white. Hue kept, saturation capped at 0.45, lightness set to 0.945.
  //
  // This was not cosmetic. With these left alone the "light" renders still carried large
  // dark panels: constellize-layer-diagram measured 74% dark pixels, health-check-
  // architecture 69%, ai-failure-modes 61% -- the exact heavy-ink defect the remap exists
  // to remove. All sixteen are used as backgroundColor only, never as strokeColor
  // (verified across all 61 sources), so lightening them cannot make a stroke vanish.
  '#1a2d32': '#EDF4F5',
  '#0f2830': '#EBF4F7',
  '#1a1a2e': '#EDEDF5',
  '#2a1820': '#F5EDF1',
  '#0f2820': '#EBF7F3',
  '#1a2332': '#EDF0F5',
  '#2a2520': '#F3F1EF',
  '#0f1a1f': '#ECF3F6',
  '#2e2010': '#F7F1EB',
  '#1a4d47': '#EBF7F6',
  '#1a3d4a': '#EBF4F7',
  '#2a2a3e': '#EEEEF4',
  '#1a5d57': '#EBF7F6',
  '#1a3d37': '#EBF7F5',
  '#1a3d2a': '#EBF7F0',
  '#3d2e1a': '#F7F2EB',

  // --- Stray accents -----------------------------------------------------------------
  // Same treatment as the main palette: darkened along their own hue until AA on white.
  '#12b886': '#0D8763', //  2.55:1 ->  4.50:1   green
  '#2f9e44': '#28873A', //  3.45:1 ->  4.55:1   green
  '#f08c00': '#AE6500', //  2.48:1 ->  4.51:1   orange
  '#999999': '#767676', //  2.85:1 ->  4.54:1   grey
  '#FF6B6B': '#C92A2A', //  2.78:1 ->  5.46:1   coral red. The AA-minimum answer here was
                        //  #EE0000, rejected for the same reason #EC002B was earlier: a
                        //  pure saturated red is too hot to hold in CMYK. #C92A2A clears
                        //  AA with room to spare and separates cleanly.
  // #9c36b5 (5.82:1) and #333333 (12.63:1) already clear AA and are left alone.
};

/** Remap one colour value, preserving any 2-digit alpha suffix and `transparent`. */
function remapColor(value) {
  if (typeof value !== 'string' || value === 'transparent') return value;
  const m = /^(#[0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value.trim());
  if (!m) return value;
  const [, base, alpha] = m;
  const hit = MAP[base] || MAP[base.toUpperCase()] || MAP[base.toLowerCase()];
  if (!hit) return value;
  return alpha ? hit + alpha : hit;
}

/** Remap a parsed .excalidraw document in place and report what changed. */
/**
 * Grounds only. This is deliberately NOT the element map.
 *
 * The element map sends #FFFFFF -> #1E2430, because a WHITE STROKE on a dark ground has to
 * become dark ink on white. Applying that same rule to viewBackgroundColor turns an
 * already-light document's white ground into near-black -- so running the remap twice
 * inverted all 61 diagrams while cheerfully reporting success. Grounds get their own table,
 * and anything not listed is left alone, which makes the whole transform idempotent.
 */
const GROUND_MAP = {
  '#0B1020': '#FFFFFF',
  '#1a1a2e': '#FFFFFF',
  '#0f1a1f': '#FFFFFF',
};

function remapGround(value) {
  if (typeof value !== 'string') return '#FFFFFF';
  const base = value.trim();
  return GROUND_MAP[base] || GROUND_MAP[base.toUpperCase()] || GROUND_MAP[base.toLowerCase()] || base;
}

function toLightTheme(doc) {
  let changed = 0;
  const app = doc.appState || (doc.appState = {});
  const before = app.viewBackgroundColor;
  app.viewBackgroundColor = remapGround(before);
  if (app.viewBackgroundColor !== before) changed++;
  // Excalidraw honours an explicit theme; make the intent unambiguous for any renderer.
  app.theme = 'light';

  for (const el of doc.elements || []) {
    for (const key of ['strokeColor', 'backgroundColor']) {
      const next = remapColor(el[key]);
      if (next !== el[key]) { el[key] = next; changed++; }
    }
  }
  return changed;
}

module.exports = { MAP, GROUND_MAP, remapColor, remapGround, toLightTheme };
