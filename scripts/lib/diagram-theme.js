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
function toLightTheme(doc) {
  let changed = 0;
  const app = doc.appState || (doc.appState = {});
  const before = app.viewBackgroundColor;
  app.viewBackgroundColor = remapColor(before) || '#FFFFFF';
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

module.exports = { MAP, remapColor, toLightTheme };
