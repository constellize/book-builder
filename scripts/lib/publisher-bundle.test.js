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

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
