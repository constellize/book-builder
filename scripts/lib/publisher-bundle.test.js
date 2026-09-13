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

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
