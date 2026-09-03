#!/usr/bin/env node

/**
 * docx-postprocess.test.js — unit tests for the .docx post-process.
 *
 *     node scripts/lib/docx-postprocess.test.js
 *
 * These cover the pure XML functions only. The end-to-end behaviour they exist
 * to protect — chapters landing on recto pages, markers rendering in Atkinson —
 * is not observable from XML and was verified by rendering with Microsoft Word
 * and LibreOffice; see the module header for what those measurements showed.
 * What is testable here is the machinery that makes those results repeatable:
 * idempotence, schema position, the bookmark ordering the TOC depends on, and
 * every guard that is supposed to fail loudly.
 */

'use strict';

const assert = require('assert');
const pp = require('./docx-postprocess.js');
const styleSpec = require('../../config/docx-styles.js');

const spec = styleSpec.resolve('print');

let passed = 0;
let failed = 0;

/**
 * Run one test case.
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn();
    console.log(`  [ OK ] ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
    failed++;
  }
}

/** Assert that `fn` throws with a message matching `re`. */
function throws(fn, re, what) {
  assert.throws(fn, (err) => re.test(err.message), what);
}

// ---------------------------------------------------------------------------
// fixtures — shaped exactly like pandoc's docx writer output, including its
// space-before-slash tag style and its pretty-printed body sectPr.
// ---------------------------------------------------------------------------

const BODY_SECTPR = `<w:sectPr>
      <w:headerReference r:id="rId901" w:type="default" />
      <w:headerReference r:id="rId902" w:type="even" />
      <w:headerReference r:id="rId903" w:type="first" />
      <w:footerReference r:id="rId904" w:type="default" />
      <w:footerReference r:id="rId905" w:type="even" />
      <w:footnotePr><w:numRestart w:val="eachSect" /></w:footnotePr>
      <w:type w:val="oddPage" />
      <w:pgSz w:h="15840" w:w="12240" />
      <w:pgMar w:bottom="1440" w:footer="720" w:gutter="288" w:header="720" w:left="1440" w:right="1440" w:top="1440" />
      <w:pgNumType w:fmt="decimal" />
      <w:titlePg />
    </w:sectPr>`;

const heading = (id, text) =>
  `<w:bookmarkStart w:id="9" w:name="${id}" />\n    ` +
  `<w:p><w:pPr><w:pStyle w:val="Heading1" /></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

const doc = (inner) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<w:document xmlns:w="w" xmlns:r="r"><w:body>\n    ' +
  inner +
  `\n    ${BODY_SECTPR}\n  </w:body></w:document>`;

/** Title page, TOC, then three chapters — the shape of the real book. */
const THREE_CHAPTERS = doc(
  '<w:p><w:pPr><w:pStyle w:val="Title" /></w:pPr><w:r><w:t>Book</w:t></w:r></w:p>\n    ' +
    heading('one', 'One') +
    '\n    <w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr><w:r><w:t>a</w:t></w:r></w:p>\n    ' +
    '<w:bookmarkEnd w:id="9" />\n    ' +
    heading('two', 'Two') +
    '\n    ' +
    heading('three', 'Three')
);

console.log('=== unit tests ===');

// ---------------------------------------------------------------------------
// section breaks
// ---------------------------------------------------------------------------

test('inserts one break per chapter and leaves the body sectPr alone', () => {
  const r = pp.insertChapterSections(THREE_CHAPTERS, spec);
  assert.strictEqual(r.inserted, 3);
  assert.strictEqual(r.removed, 0);
  assert.strictEqual(r.skipped, 0);
  // 3 paragraph-level + 1 body-level
  assert.strictEqual((r.xml.match(/<w:sectPr\b/g) || []).length, 4);
});

test('every emitted sectPr repeats the full page setup and the r:ids', () => {
  const { sectPr } = pp.insertChapterSections(THREE_CHAPTERS, spec);
  // A sectPr does not inherit: each of these missing means a silent revert to
  // Word's defaults for that section.
  for (const frag of [
    'r:id="rId901"',
    'r:id="rId902"',
    'r:id="rId903"',
    'r:id="rId904"',
    'r:id="rId905"',
    'w:w="12240"',
    'w:h="15840"',
    'w:gutter="288"',
    '<w:pgNumType',
    '<w:titlePg',
  ]) {
    assert.ok(sectPr.includes(frag), `cloned sectPr is missing ${frag}`);
  }
});

test('w:type is forced to oddPage, once, in schema position', () => {
  const { sectPr } = pp.insertChapterSections(THREE_CHAPTERS, spec);
  assert.strictEqual((sectPr.match(/<w:type\b/g) || []).length, 1);
  assert.ok(/<w:type w:val="oddPage"\/><w:pgSz\b/.test(sectPr), sectPr);
  // ...and it is still forced when the source section had a different type.
  const other = BODY_SECTPR.replace('oddPage', 'nextPage');
  const rebuilt = pp.buildChapterSectPr(
    other.slice(other.indexOf('>') + 1, other.lastIndexOf('</w:sectPr>')),
    spec
  );
  assert.ok(rebuilt.includes('<w:type w:val="oddPage"/>'));
  assert.ok(!rebuilt.includes('nextPage'));
});

test('the break lands BEFORE the heading bookmark, so TOC links stay on target', () => {
  const { xml } = pp.insertChapterSections(THREE_CHAPTERS, spec);
  // A bookmarkStart between the break and its heading would anchor the TOC
  // entry to the previous page.
  assert.ok(
    !/<w:bookmarkStart[^>]*\/>\s*<w:p><w:pPr><w:pStyle w:val="BodyText"\/><w:spacing[^>]*w:line="1"/.test(
      xml
    ),
    'a break paragraph was inserted after a bookmarkStart'
  );
  for (const name of ['one', 'two', 'three']) {
    const at = xml.indexOf(`w:name="${name}"`);
    const before = xml.slice(0, at);
    assert.ok(
      before.lastIndexOf('</w:sectPr></w:pPr></w:p>') > before.lastIndexOf('</w:r></w:p>') ||
        name === 'one',
      `bookmark "${name}" is not immediately after its section break`
    );
  }
});

test('re-running replaces breaks instead of stacking them', () => {
  const once = pp.insertChapterSections(THREE_CHAPTERS, spec);
  const twice = pp.insertChapterSections(once.xml, spec);
  assert.strictEqual(twice.removed, 3);
  assert.strictEqual(twice.inserted, 3);
  assert.strictEqual(twice.xml, once.xml, 'second run changed the XML');
  assert.strictEqual(pp.insertChapterSections(twice.xml, spec).xml, once.xml);
});

test('a chapter that is already the first body block gets no break', () => {
  const r = pp.insertChapterSections(doc(heading('one', 'One')), spec);
  assert.strictEqual(r.inserted, 0);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual((r.xml.match(/<w:sectPr\b/g) || []).length, 1);
});

test('a sectPr-carrying paragraph with real content is never deleted', () => {
  // Only run-free paragraphs are ours. This one is a hand edit and must survive.
  const authored =
    `<w:p><w:pPr><w:pStyle w:val="BodyText" />${BODY_SECTPR}</w:pPr>` +
    '<w:r><w:t>hand written</w:t></w:r></w:p>';
  const r = pp.insertChapterSections(doc(authored + '\n    ' + heading('two', 'Two')), spec);
  assert.strictEqual(r.removed, 0);
  assert.ok(r.xml.includes('hand written'));
});

test('guards fire loudly instead of inventing geometry', () => {
  throws(
    () => pp.insertChapterSections('<w:document><w:body></w:body></w:document>', spec),
    /has no <w:sectPr>/,
    'missing sectPr'
  );
  throws(
    () =>
      pp.insertChapterSections(
        doc(heading('a', 'A')).replace(/<w:pgSz[^>]*\/>/, ''),
        spec
      ),
    /has no <w:pgSz>/,
    'missing page size'
  );
  throws(
    () =>
      pp.insertChapterSections(
        doc(heading('a', 'A')).replace(/<w:headerReference[^>]*\/>/g, ''),
        spec
      ),
    /declares no <w:headerReference>/,
    'missing running heads'
  );
  throws(
    () => pp.insertChapterSections(doc(heading('a', 'A')).replace('12240', '9360'), spec),
    /document geometry w=9360 does not match/,
    'wrong trim size'
  );
  throws(
    () =>
      pp.insertChapterSections(
        doc('<w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr></w:p>'),
        spec
      ),
    /found no paragraphs styled Heading1/,
    'no chapters'
  );
});

// ---------------------------------------------------------------------------
// list markers
// ---------------------------------------------------------------------------

/** pandoc's real generated shape: bullets carry an rPr, ordered levels do not. */
const NUMBERING =
  '<w:numbering xmlns:w="w">' +
  '<w:abstractNum w:abstractNumId="991">' +
  '<w:lvl w:ilvl="0"><w:numFmt w:val="bullet" /><w:lvlText w:val="" />' +
  '<w:lvlJc w:val="left" /><w:pPr><w:ind w:left="720" w:hanging="360" /></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:cs="Symbol" w:hint="default" /></w:rPr></w:lvl>' +
  '<w:lvl w:ilvl="1"><w:numFmt w:val="bullet" /><w:lvlText w:val="o" />' +
  '<w:lvlJc w:val="left" />' +
  '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:hint="default" /></w:rPr></w:lvl>' +
  '<w:lvl w:ilvl="2"><w:numFmt w:val="bullet" /><w:lvlText w:val="" />' +
  '<w:rPr><w:rFonts w:ascii="Wingdings" w:hAnsi="Wingdings" w:hint="default" /></w:rPr></w:lvl>' +
  '<w:lvl w:ilvl="3"><w:numFmt w:val="bullet" /><w:lvlText w:val="" /></w:lvl>' +
  '</w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="99411">' +
  '<w:lvl w:ilvl="0"><w:numFmt w:val="decimal" /><w:lvlText w:val="%1." />' +
  '<w:lvlJc w:val="left" /><w:pPr><w:ind w:left="720" w:hanging="360" /></w:pPr></w:lvl>' +
  '<w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter" /><w:lvlText w:val="(%2)" /></w:lvl>' +
  '</w:abstractNum>' +
  '</w:numbering>';

test('every level gets the book font, replacing or appending as needed', () => {
  const r = pp.patchNumbering(NUMBERING, spec.listMarkers);
  assert.strictEqual(r.levels, 6);
  assert.strictEqual(r.bullets, 4);
  assert.strictEqual(r.ordered, 2);
  for (const foreign of ['Symbol', 'Courier New', 'Wingdings']) {
    assert.ok(!r.xml.includes(`"${foreign}"`), `${foreign} survived the patch`);
  }
  // 6 levels, each with exactly one rFonts naming the book font.
  const hits = r.xml.match(/<w:rFonts w:ascii="Atkinson Hyperlegible Next"/g) || [];
  assert.strictEqual(hits.length, 6);
  // The ordered levels had no w:rPr at all: that is the append branch.
  assert.ok(/<w:lvlText w:val="%1\."\s*\/>[\s\S]*?<w:rPr><w:rFonts/.test(r.xml));
});

test('bullet lvlText is replaced; ordered lvlText is preserved', () => {
  const r = pp.patchNumbering(NUMBERING, spec.listMarkers);
  assert.ok(!/|/.test(r.xml), 'a private-use marker survived');
  assert.ok(r.xml.includes('<w:lvlText w:val="•"/>'), 'no U+2022 at ilvl 0');
  assert.ok(r.xml.includes('<w:lvlText w:val="–"/>'), 'no U+2013 at ilvl 1');
  assert.ok(r.xml.includes('<w:lvlText w:val="·"/>'), 'no U+00B7 at ilvl 2');
  // ilvl 3 wraps back to the first marker, the way pandoc cycles its own three.
  assert.strictEqual((r.xml.match(/w:val="•"/g) || []).length, 2);
  assert.ok(r.xml.includes('w:val="%1."'), 'decimal format was clobbered');
  assert.ok(r.xml.includes('w:val="(%2)"'), 'lettered format was clobbered');
});

test('patching is idempotent', () => {
  const once = pp.patchNumbering(NUMBERING, spec.listMarkers).xml;
  const twice = pp.patchNumbering(once, spec.listMarkers).xml;
  assert.strictEqual(twice, once);
  assert.strictEqual(pp.patchNumbering(twice, spec.listMarkers).xml, once);
});

test('markers are never matched by abstractNum id', () => {
  // pandoc derives ordered ids from the formats in the source: a document with
  // lettered lists produced 99431/99512/99711/99811. Anything keyed on an id
  // breaks the first time an author adds one.
  const renumbered = NUMBERING.replace(/99411/g, '99831').replace(/991/g, '5000');
  const r = pp.patchNumbering(renumbered, spec.listMarkers);
  assert.strictEqual(r.levels, 6);
  assert.strictEqual(r.bullets, 4);
});

test('numbering guards fire loudly', () => {
  throws(
    () => pp.patchNumbering('<w:numbering/>', spec.listMarkers),
    /contains no <w:lvl>/,
    'empty numbering'
  );
  throws(
    () =>
      pp.patchNumbering(
        '<w:numbering><w:lvl w:ilvl="0"><w:lvlText w:val="x" /></w:lvl></w:numbering>',
        spec.listMarkers
      ),
    /has no <w:numFmt>/,
    'no numFmt'
  );
  throws(
    () =>
      pp.patchNumbering(
        '<w:numbering><w:lvl><w:numFmt w:val="bullet" /></w:lvl></w:numbering>',
        spec.listMarkers
      ),
    /no w:ilvl attribute/,
    'no ilvl'
  );
  throws(
    () =>
      pp.patchNumbering(
        '<w:numbering><w:lvl w:ilvl="0"><w:numFmt w:val="bullet" /></w:lvl></w:numbering>',
        spec.listMarkers
      ),
    /has no <w:lvlText> to rewrite/,
    'no lvlText'
  );
  throws(
    () => pp.patchNumbering(NUMBERING, { font: 'X', bullets: [] }),
    /must be a non-empty array/,
    'empty bullet cycle'
  );
});

test('marker characters are ones Atkinson actually has', () => {
  // The whole point of the patch is to stop shipping glyphs the embedded faces
  // cannot draw. Guard the config against a future edit that reintroduces one.
  const ATKINSON_HAS = new Set([0x2022, 0x2013, 0x00b7, 0x2014, 0x2212, 0x2026]);
  for (const b of spec.listMarkers.bullets) {
    assert.strictEqual([...b].length, 1, `marker ${JSON.stringify(b)} is not one character`);
    const cp = b.codePointAt(0);
    assert.ok(
      cp < 0x0250 || ATKINSON_HAS.has(cp),
      `U+${cp.toString(16).toUpperCase()} is not known to be in Atkinson Hyperlegible; ` +
        'verify with fontTools before adding it'
    );
  }
});

console.log(
  failed === 0
    ? `\nALL ${passed} UNIT TESTS PASSED`
    : `\n${failed} of ${passed + failed} UNIT TESTS FAILED`
);
process.exit(failed === 0 ? 0 : 1);
