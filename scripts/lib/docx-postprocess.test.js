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
      <w:footerReference r:id="rId906" w:type="first" />
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
    // The `first` footer. Without it in the CLONE, chapter 1 would get a folio
    // on its opening page and chapters 2..N would not — the exact asymmetry
    // that makes a cloned-sectPr bug look like a one-off typographic glitch.
    'r:id="rId906"',
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
    /missing <w:headerReference w:type="default">.*<w:headerReference w:type="first">/,
    'missing running heads'
  );
  throws(
    () =>
      pp.insertChapterSections(
        // Exactly the pre-fix state: a blank `first` header and no `first`
        // footer, so every chapter opening loses its page number silently.
        doc(heading('a', 'A')).replace(/<w:footerReference[^>]*w:type="first"[^>]*\/>/, ''),
        spec
      ),
    /missing <w:footerReference w:type="first">/,
    'missing chapter-opening folio'
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

// ---------------------------------------------------------------------------
// table of contents
//
// The behaviour these protect — a Contents page that is populated the moment
// the reader opens the file — is not observable from XML, and was verified by
// rendering with Word WITHOUT updating any field and checking every cached page
// number against the physical page the heading landed on. What is testable here
// is the machinery that makes that repeatable: that the cache is rebuilt rather
// than appended to, that no entry can point at a bookmark that is not there,
// and that every guard fires.
// ---------------------------------------------------------------------------

/** pandoc's empty TOC field, byte for byte including its space-before-slash. */
const EMPTY_TOC_FIELD =
  '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true" />' +
  '<w:instrText xml:space="preserve">TOC \\o &quot;1-3&quot; \\h \\z \\u</w:instrText>' +
  '<w:fldChar w:fldCharType="separate" /><w:fldChar w:fldCharType="end" /></w:r></w:p>';

const sub = (id, level, text, number) =>
  `<w:bookmarkStart w:id="8" w:name="${id}" />\n    ` +
  `<w:p><w:pPr><w:pStyle w:val="Heading${level}" /></w:pPr>` +
  (number
    ? `<w:r><w:rPr><w:rStyle w:val="SectionNumber" /></w:rPr><w:t>${number}</w:t></w:r>` +
      '<w:r><w:tab /></w:r>'
    : '') +
  `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** Title page, the empty TOC field, then a chapter with two subsections. */
const WITH_TOC = doc(
  '<w:p><w:pPr><w:pStyle w:val="Title" /></w:pPr><w:r><w:t>Book</w:t></w:r></w:p>\n    ' +
    EMPTY_TOC_FIELD +
    '\n    ' +
    sub('one', 1, 'One', '1') +
    '\n    ' +
    sub('one-a', 2, 'One A', '1.1') +
    '\n    ' +
    sub('one-a-i', 3, 'Deep &amp; Dangerous', null) +
    '\n    ' +
    sub('back', 1, 'Appendix A: Things', null)
);

const STYLES_XML =
  '<?xml version="1.0"?><w:styles xmlns:w="w">' +
  '<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/></w:style>' +
  '</w:styles>';

test('finds pandoc\'s empty TOC field and reads its instruction', () => {
  const f = pp.findTocField(WITH_TOC);
  assert.ok(f, 'no field found');
  assert.strictEqual(f.instr, 'TOC \\o "1-3" \\h \\z \\u', 'entities not decoded');
  assert.strictEqual(
    WITH_TOC.slice(f.start, f.end),
    EMPTY_TOC_FIELD,
    'the span is not exactly the field paragraph'
  );
});

test('collects every Heading1-3 with its bookmark, number and title', () => {
  const h = pp.collectTocHeadings(WITH_TOC, spec);
  assert.deepStrictEqual(
    h,
    [
      { level: 1, anchor: 'one', number: '1', title: 'One' },
      { level: 2, anchor: 'one-a', number: '1.1', title: 'One A' },
      // Escaped source XML is carried through, NOT decoded and re-encoded.
      { level: 3, anchor: 'one-a-i', number: null, title: 'Deep &amp; Dangerous' },
      { level: 1, anchor: 'back', number: null, title: 'Appendix A: Things' },
    ]
  );
});

test('a heading with no bookmark fails loudly instead of linking nowhere', () => {
  const orphan = WITH_TOC.replace('<w:bookmarkStart w:id="8" w:name="one-a" />', '');
  throws(
    () => pp.collectTocHeadings(orphan, spec),
    /have no <w:bookmarkStart> immediately before them/,
    'orphaned heading'
  );
});

test('the built cache has one entry per heading, all anchored, page numbers blank', () => {
  const h = pp.collectTocHeadings(WITH_TOC, spec);
  const field = pp.buildTocField(h, spec, { pageNumbers: true });
  const styles = ['TOC1', 'TOC2', 'TOC3', 'TOC1'];
  assert.deepStrictEqual(
    [...field.matchAll(/<w:pStyle w:val="(TOC\d)"\/>/g)].map((m) => m[1]),
    styles
  );
  assert.deepStrictEqual(
    [...field.matchAll(/<w:hyperlink w:anchor="([^"]+)"/g)].map((m) => m[1]),
    ['one', 'one-a', 'one-a-i', 'back']
  );
  assert.strictEqual(
    (field.match(/ PAGEREF /g) || []).length,
    4,
    'one PAGEREF per entry'
  );
  // Blank cached results: the oracle fills these in, we do not guess them.
  assert.strictEqual((field.match(/<w:t><\/w:t>/g) || []).length, 4);
  // The field's own begin/separate go in the first paragraph, its end in the last.
  assert.strictEqual((field.match(/<w:instrText xml:space="preserve">TOC /g) || []).length, 1);
  assert.ok(field.endsWith('<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'));
});

test('page numbers land on the right entries', () => {
  const h = pp.collectTocHeadings(WITH_TOC, spec);
  const field = pp.buildTocField(h, spec, { pageNumbers: true, pages: [3, 4, 5, 99] });
  assert.deepStrictEqual(
    [...field.matchAll(/<w:webHidden\/><\/w:rPr><w:t>(\d+)<\/w:t>/g)].map((m) => m[1]),
    ['3', '4', '5', '99']
  );
});

test('the no-Word form drops the leader tab and the PAGEREF, not the links', () => {
  const h = pp.collectTocHeadings(WITH_TOC, spec);
  const field = pp.buildTocField(h, spec, { pageNumbers: false });
  assert.strictEqual((field.match(/PAGEREF/g) || []).length, 0, 'PAGEREF survived');
  assert.strictEqual((field.match(/w:leader="dot"/g) || []).length, 0, 'leader tab survived');
  assert.strictEqual((field.match(/<w:hyperlink /g) || []).length, 4, 'links were dropped');
  assert.ok(field.includes('\\n</w:instrText>'), 'instruction does not suppress page numbers');
});

test('rebuilding replaces the cache instead of stacking a second one', () => {
  const h = pp.collectTocHeadings(WITH_TOC, spec);
  const once = pp.replaceTocField(WITH_TOC, pp.buildTocField(h, spec, { pageNumbers: true })).xml;
  const twice = pp.replaceTocField(once, pp.buildTocField(h, spec, { pageNumbers: true })).xml;
  assert.strictEqual(twice, once, 'not idempotent');
  // And the second pass still saw ONE field, not a nested mess.
  assert.strictEqual((once.match(/<w:instrText xml:space="preserve">TOC /g) || []).length, 1);
  // Swapping to the no-page-number form and back is also lossless.
  const noPages = pp.replaceTocField(once, pp.buildTocField(h, spec, { pageNumbers: false })).xml;
  const back = pp.replaceTocField(noPages, pp.buildTocField(h, spec, { pageNumbers: true })).xml;
  assert.strictEqual(back, once, 'round trip through the \\n form is lossy');
});

test('findTocField counts nested PAGEREF fields correctly', () => {
  // The reason the span search balances begin/end rather than stopping at the
  // first `end`: every entry contains a whole PAGEREF field of its own.
  const h = pp.collectTocHeadings(WITH_TOC, spec);
  const built = pp.replaceTocField(WITH_TOC, pp.buildTocField(h, spec, { pageNumbers: true })).xml;
  const f = pp.findTocField(built);
  const span = built.slice(f.start, f.end);
  assert.strictEqual((span.match(/<w:pStyle w:val="TOC\d"\/>/g) || []).length, 4);
  assert.ok(!span.includes('<w:pStyle w:val="Heading1" />'), 'span ran past the field');
  assert.ok(built.slice(f.end).includes('Heading1'), 'the body was swallowed');
});

test('a document with no TOC field fails loudly', () => {
  throws(
    () => pp.replaceTocField(THREE_CHAPTERS, '<w:p/>'),
    /contains no TOC field/,
    'missing field'
  );
});

test('the TOC styles are built-in, not custom, and reset the body indent', () => {
  const xml = pp.tocStyleXml(spec);
  assert.ok(!xml.includes('w:customStyle'), 'built-in styles must not be marked custom');
  assert.deepStrictEqual(
    [...xml.matchAll(/<w:name w:val="([^"]+)"\/>/g)].map((m) => m[1]),
    ['toc 1', 'toc 2', 'toc 3']
  );
  // BodyText carries the book's 340tw first-line indent; inheriting it would
  // indent every Contents line.
  assert.strictEqual((xml.match(/w:firstLine="0"/g) || []).length, 3);
  assert.strictEqual((xml.match(/<w:basedOn w:val="BodyText"\/>/g) || []).length, 3);
});

test('injecting the TOC styles is idempotent and updates in place', () => {
  const first = pp.injectTocStyles(STYLES_XML, spec);
  assert.deepStrictEqual(first.injected, ['TOC1', 'TOC2', 'TOC3']);
  assert.deepStrictEqual(first.replaced, []);
  const second = pp.injectTocStyles(first.xml, spec);
  assert.strictEqual(second.xml, first.xml, 'not idempotent');
  // Replaced, not skipped: a spec change must take effect on a re-run.
  assert.deepStrictEqual(second.replaced, ['TOC1', 'TOC2', 'TOC3']);
  assert.strictEqual((second.xml.match(/w:styleId="TOC1"/g) || []).length, 1, 'duplicated');
});

test('page numbers are read back by anchor, in document order', () => {
  const h = pp.collectTocHeadings(WITH_TOC, spec);
  const built = pp.replaceTocField(
    WITH_TOC,
    pp.buildTocField(h, spec, { pageNumbers: true, pages: [3, 4, 5, 99] })
  ).xml;
  assert.deepStrictEqual(pp.readTocPageNumbers(built), [
    { anchor: 'one', page: '3' },
    { anchor: 'one-a', page: '4' },
    { anchor: 'one-a-i', page: '5' },
    { anchor: 'back', page: '99' },
  ]);
});

test('a PAGEREF outside the TOC is never mistaken for an entry', () => {
  const h = pp.collectTocHeadings(WITH_TOC, spec);
  let built = pp.replaceTocField(
    WITH_TOC,
    pp.buildTocField(h, spec, { pageNumbers: true, pages: [3, 4, 5, 99] })
  ).xml;
  built = built.replace(
    '</w:body>',
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> PAGEREF stray \\h </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>404</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body>'
  );
  const got = pp.readTocPageNumbers(built);
  assert.strictEqual(got.length, 4, 'the stray PAGEREF was counted');
  assert.ok(!got.some((g) => g.anchor === 'stray'));
});

test('the stale-cache markers are removed from both files', () => {
  const settings = '<w:settings><w:savePreviewPicture/><w:updateFields w:val="true"/></w:settings>';
  const r = pp.stripFieldRefreshFlags(WITH_TOC, settings);
  assert.strictEqual(r.dirty, 1);
  assert.strictEqual(r.updates, 1);
  assert.ok(!r.doc.includes('w:dirty'));
  assert.ok(!r.settings.includes('updateFields'));
  // The fldChar itself must survive: this clears a flag, it does not delete the field.
  assert.ok(r.doc.includes('<w:fldChar w:fldCharType="begin" />'));
  // Idempotent.
  const again = pp.stripFieldRefreshFlags(r.doc, r.settings);
  assert.strictEqual(again.doc, r.doc);
  assert.strictEqual(again.settings, r.settings);
  assert.strictEqual(again.dirty, 0);
});

test('every TOC style the entries name is a style the spec defines', () => {
  // The entry paragraphs reference TOC_STYLE_IDS by index; a spec with a fourth
  // level and no fourth style id would silently emit `undefined`.
  assert.strictEqual(spec.toc.levels.length, pp.TOC_STYLE_IDS.length);
  const h = pp.collectTocHeadings(WITH_TOC, spec);
  const field = pp.buildTocField(h, spec, { pageNumbers: true });
  assert.ok(!field.includes('undefined'), 'an entry named a style that does not exist');
});

// ---------------------------------------------------------------------------
// the Contents pages' running head
// ---------------------------------------------------------------------------

const HEADER_WITH_STYLEREF =
  '<w:hdr xmlns:w="w" xmlns:r="r"><w:tbl><w:tr><w:tc><w:p><w:pPr>' +
  '<w:pStyle w:val="Header"/></w:pPr>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> STYLEREF &quot;Heading 1&quot; \\* MERGEFORMAT </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t>Chapter</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
  '</w:p></w:tc><w:tc><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> PAGE \\* MERGEFORMAT </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
  '</w:p></w:tc></w:tr></w:tbl></w:hdr>';

const RELS =
  '<?xml version="1.0"?><Relationships xmlns="R">' +
  '<Relationship Id="rId901" Target="header1.xml" Type="T"/>' +
  '<Relationship Id="rId902" Target="header2.xml" Type="T"/>' +
  '</Relationships>';

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="C"></Types>';

/** In-memory stand-in for the unzipped package. */
function fakeIo(extra = {}) {
  const files = {
    'word/_rels/document.xml.rels': RELS,
    '[Content_Types].xml': CONTENT_TYPES,
    'word/header1.xml': HEADER_WITH_STYLEREF,
    'word/header2.xml': HEADER_WITH_STYLEREF,
    ...extra,
  };
  return {
    files,
    exists: (rel) => Object.prototype.hasOwnProperty.call(files, rel),
    read: (rel) => files[rel],
    write: (rel, data) => {
      files[rel] = data;
    },
  };
}

test('STYLEREF is replaced by literal text, and the PAGE field survives', () => {
  const out = pp.styleRefToLiteral(HEADER_WITH_STYLEREF, 'Contents');
  assert.ok(out, 'no replacement made');
  assert.ok(!out.includes('STYLEREF'), 'the STYLEREF field survived');
  assert.ok(out.includes('<w:t xml:space="preserve">Contents</w:t>'));
  // The folio must still be a live PAGE field, and the rule/table must survive.
  assert.ok(out.includes('PAGE \\* MERGEFORMAT'), 'the PAGE field was eaten');
  assert.strictEqual((out.match(/<w:tc>/g) || []).length, 2, 'the header table was damaged');
  assert.strictEqual(pp.styleRefToLiteral('<w:hdr/>', 'Contents'), null, 'no field, no claim');
});

test('the front-matter section gets its own headers, and only that section', () => {
  const withToc = pp.insertChapterSections(WITH_TOC, spec);
  const io = fakeIo();
  const r = pp.applyContentsHeader(io, withToc.xml, 'Contents');
  assert.strictEqual(r.applied, true, r.reason);
  assert.deepStrictEqual(r.parts.sort(), [
    'word/headerContentsEven.xml',
    'word/headerContentsOdd.xml',
  ]);

  // Exactly ONE section break points at the new headers; the other three still
  // point at the book's own.
  const odd = (r.xml.match(/r:id="rIdContentsHeaderOdd"/g) || []).length;
  const even = (r.xml.match(/r:id="rIdContentsHeaderEven"/g) || []).length;
  assert.strictEqual(odd, 1, `${odd} sections rewired to the odd header, expected 1`);
  assert.strictEqual(even, 1, `${even} sections rewired to the even header, expected 1`);
  assert.ok(
    (r.xml.match(/r:id="rId901"/g) || []).length >= 1,
    'every section lost the book header, not just the front matter'
  );

  // And it is the FIRST one - the one after the TOC.
  const at = r.xml.indexOf('rIdContentsHeaderOdd');
  assert.ok(
    r.xml.slice(0, at).includes('TOC \\o'),
    'the rewired section is not the one that follows the Contents'
  );

  // Package plumbing.
  assert.ok(io.files['word/headerContentsOdd.xml'].includes('Contents'));
  assert.ok(!io.files['word/headerContentsOdd.xml'].includes('STYLEREF'));
  assert.ok(io.files['word/_rels/document.xml.rels'].includes('Id="rIdContentsHeaderOdd"'));
  assert.ok(
    io.files['[Content_Types].xml'].includes('PartName="/word/headerContentsOdd.xml"'),
    'no content-type override; Word would refuse to open the package'
  );
});

test('rewiring the running head is idempotent', () => {
  const withToc = pp.insertChapterSections(WITH_TOC, spec);
  const io = fakeIo();
  const once = pp.applyContentsHeader(io, withToc.xml, 'Contents');
  // Second pass starts from a document that already points at the new headers,
  // so the source header it copies is the new one - which has no STYLEREF.
  const twice = pp.applyContentsHeader(io, once.xml, 'Contents');
  // Recognised as already done, NOT reported as "the header has no STYLEREF" -
  // which is true of our own output and would read as a failure.
  assert.strictEqual(twice.applied, true, twice.reason);
  assert.strictEqual(twice.reason, null);
  assert.strictEqual(twice.xml, once.xml, 'the document was changed on a no-op pass');
  assert.strictEqual(
    (io.files['word/_rels/document.xml.rels'].match(/rIdContentsHeaderOdd/g) || []).length,
    1,
    'the relationship was added twice'
  );
});

test('it refuses to rewire a section that is not the front matter', () => {
  // No TOC field before the first break => this is not the section we mean.
  const noToc = pp.insertChapterSections(THREE_CHAPTERS, spec);
  const r = pp.applyContentsHeader(fakeIo(), noToc.xml, 'Contents');
  assert.strictEqual(r.applied, false);
  assert.match(r.reason, /does not follow the TOC field/);
  assert.strictEqual(r.xml, noToc.xml, 'the document was modified anyway');
});

test('a header it does not recognise is reported, not guessed at', () => {
  const withToc = pp.insertChapterSections(WITH_TOC, spec);
  const io = fakeIo({ 'word/header2.xml': '<w:hdr xmlns:w="w"><w:p/></w:hdr>' });
  const r = pp.applyContentsHeader(io, withToc.xml, 'Contents');
  assert.strictEqual(r.applied, false);
  assert.match(r.reason, /no STYLEREF field to replace/);
  assert.strictEqual(r.xml, withToc.xml, 'a failed rewire must leave the document alone');
});

console.log(
  failed === 0
    ? `\nALL ${passed} UNIT TESTS PASSED`
    : `\n${failed} of ${passed + failed} UNIT TESTS FAILED`
);
process.exit(failed === 0 ? 0 : 1);
