/**
 * The callout pin budget is declared by the TEMPLATE, and this reads the declaration.
 *
 * WHY IT IS THE TEMPLATE THAT DECLARES IT
 * ---------------------------------------
 * `callout-filter-print.lua` can set `breakable=false` on a callout it believes fits the
 * page. Every constant it measures with was calibrated against ONE geometry -- the 6x9 trim,
 * 0.75in top and bottom, 11pt at linestretch 1.2. A Lua filter cannot read `\textheight`,
 * because it runs before TeX exists, and `config/pandoc-defaults-print.yaml` does not name a
 * template: the template comes from the consuming book's own `book.config.js`. So the only
 * thing that knows the page geometry is the template, and the only safe default is to pin
 * nothing.
 *
 * A pinned box that does not fit does not warn and does not overfull. It HANGS xelatex --
 * 35 rendered code lines typeset, 36 never terminate -- so this gate is a hard one, not a
 * fallback: no declaration means no pinning, which is the pre-round-8 behaviour.
 *
 * The declaration is the macro definition itself, so there is exactly one number:
 *
 *     \newcommand{\calloutPinBudget}{433.6}
 *
 * build-book.js forwards whatever this returns as `--metadata=callout-pin-budget:<n>`, which
 * the filter's Meta pass reads. The filter does its own sanity check on the value.
 *
 * No dependencies on purpose: this is required by a build script and by a jest test.
 */

// \newcommand, \newcommand*, \renewcommand, \providecommand or \def, with or without
// braces around the macro name, and any spacing. A commented-out definition does not
// count -- a template that has switched pinning off by commenting the line out means it.
const DECL = /^[^%\n]*\\(?:re)?(?:new|provide)command\*?\s*\{?\s*\\calloutPinBudget\s*\}?\s*\{\s*([0-9]*\.?[0-9]+)\s*\}/m;
const DEF = /^[^%\n]*\\def\s*\\calloutPinBudget\s*\{\s*([0-9]*\.?[0-9]+)\s*\}/m;

/**
 * @param {string} templateSource contents of the pandoc LaTeX template
 * @returns {number|null} the declared budget in TeX points, or null when the template
 *   declares none (or declares something that is not a positive number)
 */
function readCalloutPinBudget(templateSource) {
  if (typeof templateSource !== 'string') return null;
  const m = DECL.exec(templateSource) || DEF.exec(templateSource);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = { readCalloutPinBudget };
