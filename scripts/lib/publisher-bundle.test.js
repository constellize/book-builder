/**
 * Tests for publisher-bundle.js. Run with:  node scripts/lib/publisher-bundle.test.js
 */
const assert = require('assert');
const B = require('./publisher-bundle.js');

let n = 0, f = 0;
const t = (name, fn) => { n++; try { fn(); console.log('  [ OK ] ' + name); } catch (e) { f++; console.log('  [FAIL] ' + name + ' -- ' + e.message); } };

console.log('=== constants ===');

t('lists the 13 source files in build order', () => {
  assert.deepStrictEqual(B.EXPECTED_FILES, [
    'foreword-faq.md', 'introduction.md',
    'ch1.md', 'ch2.md', 'ch3.md', 'ch4.md', 'ch5.md',
    'ch6.md', 'ch7.md', 'ch8.md', 'ch9.md',
    'appA.md', 'appB.md',
  ]);
});

console.log('\n=== normalization ===');

t('leaves clean LF content untouched', () => {
  const { text, notes } = B.normalizeBuffer(Buffer.from('one\ntwo\n', 'utf8'));
  assert.strictEqual(text, 'one\ntwo\n');
  assert.deepStrictEqual(notes, { invalidUtf8: false, hadBom: false, hadCrlf: false, addedTrailingNewline: false });
});

t('converts CRLF to LF and reports it', () => {
  const { text, notes } = B.normalizeBuffer(Buffer.from('one\r\ntwo\r\n', 'utf8'));
  assert.strictEqual(text, 'one\ntwo\n');
  assert.strictEqual(notes.hadCrlf, true);
});

t('strips a UTF-8 BOM and reports it', () => {
  const { text, notes } = B.normalizeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('title\n', 'utf8')]));
  assert.strictEqual(text, 'title\n');
  assert.strictEqual(notes.hadBom, true);
});

t('adds a missing trailing newline and reports it', () => {
  const { text, notes } = B.normalizeBuffer(Buffer.from('no newline', 'utf8'));
  assert.strictEqual(text, 'no newline\n');
  assert.strictEqual(notes.addedTrailingNewline, true);
});

t('collapses multiple trailing newlines to one', () => {
  assert.strictEqual(B.normalizeBuffer(Buffer.from('body\n\n\n', 'utf8')).text, 'body\n');
});

t('preserves non-ASCII characters exactly', () => {
  const { text, notes } = B.normalizeBuffer(Buffer.from('em—dash and "quotes"\n', 'utf8'));
  assert.strictEqual(text, 'em—dash and "quotes"\n');
  assert.strictEqual(notes.invalidUtf8, false);
});

t('flags invalid UTF-8 instead of producing mojibake', () => {
  const { notes } = B.normalizeBuffer(Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x0a]));
  assert.strictEqual(notes.invalidUtf8, true);
});

console.log('\n=== de-wrap ===');

t('restores original line breaks for an unchanged but re-wrapped paragraph', () => {
  const before = 'One two three\nfour five six.\n';
  const after = 'One two three four five six.\n';
  const out = B.dewrapParagraphs(before, after);
  assert.strictEqual(out.text, before);
  assert.strictEqual(out.dewrapped, 1);
});

t('leaves an edited paragraph in the publisher form', () => {
  const before = 'One two three\nfour five six.\n';
  const after = 'One two three four five seven.\n';
  const out = B.dewrapParagraphs(before, after);
  assert.strictEqual(out.text, after);
  assert.strictEqual(out.dewrapped, 0);
});

t('de-wraps the unchanged paragraph and keeps the edited one', () => {
  const before = 'Alpha one\ntwo.\n\nBeta one\ntwo.\n';
  const after = 'Alpha one two.\n\nBeta one two THREE.\n';
  const out = B.dewrapParagraphs(before, after);
  assert.strictEqual(out.text, 'Alpha one\ntwo.\n\nBeta one two THREE.\n');
  assert.strictEqual(out.dewrapped, 1);
});

t('never touches fenced code', () => {
  const before = '```\na\nb\n```\n';
  const after = '```\na b\n```\n';
  assert.strictEqual(B.dewrapParagraphs(before, after).text, after);
});

t('never touches list items', () => {
  const before = '- one\n  two\n';
  const after = '- one two\n';
  assert.strictEqual(B.dewrapParagraphs(before, after).text, after);
});

t('never touches table rows', () => {
  const before = '| a |\n| b |\n';
  const after = '| a | b |\n';
  assert.strictEqual(B.dewrapParagraphs(before, after).text, after);
});

t('never touches paragraphs inside ::: divs', () => {
  const before = '::: info\nOne two\nthree.\n:::\n';
  const after = '::: info\nOne two three.\n:::\n';
  assert.strictEqual(B.dewrapParagraphs(before, after).text, after);
});

t('skips a paragraph that appears more than once in the snapshot', () => {
  const before = 'Same\ntext.\n\nMiddle.\n\nSame\ntext.\n';
  const after = 'Same text.\n\nMiddle.\n\nSame text.\n';
  const out = B.dewrapParagraphs(before, after);
  assert.strictEqual(out.text, after, 'ambiguous matches are left alone');
  assert.strictEqual(out.dewrapped, 0);
});

t('skips an inserted paragraph with no counterpart', () => {
  const before = 'Alpha one\ntwo.\n';
  const after = 'Brand new paragraph.\n\nAlpha one two.\n';
  const out = B.dewrapParagraphs(before, after);
  assert.strictEqual(out.text, 'Brand new paragraph.\n\nAlpha one\ntwo.\n');
  assert.strictEqual(out.dewrapped, 1);
});

t('skips indented paragraphs', () => {
  const before = '  One two\n  three.\n';
  const after = '  One two three.\n';
  assert.strictEqual(B.dewrapParagraphs(before, after).dewrapped, 0);
});

t('restores original line breaks for a single-line paragraph hard-wrapped across three lines', () => {
  const before = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu.\n';
  const after = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet\nkilo lima mike november oscar papa quebec romeo sierra tango\nuniform victor whiskey xray yankee zulu.\n';
  const out = B.dewrapParagraphs(before, after);
  assert.strictEqual(out.text, before);
  assert.strictEqual(out.dewrapped, 1);
});

t('preserves a hard-wrapped paragraph that was also edited, rather than reverting it', () => {
  const before = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu.\n';
  const after = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet\nkilo lima MIKE-EDITED november oscar papa quebec romeo sierra tango\nuniform victor whiskey xray yankee zulu.\n';
  const out = B.dewrapParagraphs(before, after);
  assert.ok(out.text.includes('MIKE-EDITED'), 'the edit must survive');
  assert.notStrictEqual(out.text, before, 'an edited paragraph must not be reverted to the snapshot');
  assert.strictEqual(out.dewrapped, 0);
});

console.log('\n=== queries ===');

t('the shipped QUERIES.md template counts as zero queries', () => {
  // The apply step warns "the publisher left queries" off this count. The template is
  // six lines after trimming, so a line-count test fired on every untouched round.
  assert.strictEqual(B.countQueries(B.renderQueries('round-1')), 0);
});

t('counts bullets the publisher filled in', () => {
  const text = B.renderQueries('round-1') +
    '- ch3.md: "the constellation" — is this capitalised elsewhere?\n' +
    '- appA.md: the table on p.4 has two rows labelled (b)\n';
  assert.strictEqual(B.countQueries(text), 2);
});

t('counts a query the publisher wrote as prose instead of a bullet', () => {
  const text = B.renderQueries('round-1') + '\nPlease confirm the spelling of the author name.\n';
  assert.strictEqual(B.countQueries(text), 1);
});

t('an empty file counts as zero queries', () => {
  assert.strictEqual(B.countQueries(''), 0);
});

t('renders a template that names the round', () => {
  assert.ok(B.renderQueries('copy-edit-pass').includes('copy-edit-pass'));
});

console.log('\n=== manifest ===');

const MANIFEST_INPUT = {
  label: 'round-1',
  tag: 'publisher/round-1',
  commit: 'a09b7231f0c4e5d6a7b8c9d0e1f2a3b4c5d6e7f8',
  date: '2026-09-12',
  files: [
    { name: 'ch1.md', sha256: B.sha256('one\n') },
    { name: 'ch2.md', sha256: B.sha256('two\n') },
  ],
};

t('round-trips through render and parse', () => {
  const parsed = B.parseManifest(B.renderManifest(MANIFEST_INPUT));
  assert.strictEqual(parsed.label, 'round-1');
  assert.strictEqual(parsed.tag, 'publisher/round-1');
  assert.strictEqual(parsed.commit, MANIFEST_INPUT.commit);
  assert.strictEqual(parsed.date, '2026-09-12');
  assert.deepStrictEqual(parsed.files, MANIFEST_INPUT.files);
});

t('renders a human-readable header', () => {
  const text = B.renderManifest(MANIFEST_INPUT);
  assert.ok(text.includes('publisher/round-1'));
  assert.ok(text.includes(MANIFEST_INPUT.commit));
});

t('throws on a manifest with no commit line', () => {
  const broken = B.renderManifest(MANIFEST_INPUT).split('\n').filter((l) => !l.startsWith('Commit:')).join('\n');
  assert.throws(() => B.parseManifest(broken), /commit/i);
});

t('verifies matching snapshot content', () => {
  assert.deepStrictEqual(B.verifyManifest(MANIFEST_INPUT, { 'ch1.md': 'one\n', 'ch2.md': 'two\n' }), []);
});

t('reports a tampered hash', () => {
  const problems = B.verifyManifest(MANIFEST_INPUT, { 'ch1.md': 'ONE\n', 'ch2.md': 'two\n' });
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].includes('ch1.md'));
});

t('reports a file the manifest does not list', () => {
  const problems = B.verifyManifest(MANIFEST_INPUT, { 'ch1.md': 'one\n' });
  assert.ok(problems.some((p) => p.includes('ch2.md')));
});

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
