/**
 * End-to-end tests for the publisher round-trip CLIs.
 * Run with:  node scripts/lib/publisher-roundtrip.test.js
 */
const assert = require('assert');
const P = require('../package-for-publisher.js');

let n = 0, f = 0;
const t = (name, fn) => { n++; try { fn(); console.log('  [ OK ] ' + name); } catch (e) { f++; console.log('  [FAIL] ' + name + ' -- ' + e.message); } };

console.log('=== label resolution ===');

t('prefixes a bare integer with round-', () => {
  assert.strictEqual(P.resolveLabel('1', []), 'round-1');
});

t('sanitizes and lowercases a named label', () => {
  assert.strictEqual(P.resolveLabel('Copy Edit Pass!', []), 'copy-edit-pass');
});

t('defaults to the next unused integer', () => {
  assert.strictEqual(P.resolveLabel(undefined, ['publisher/round-1', 'publisher/round-2']), 'round-3');
});

t('defaults to round-1 when no rounds exist', () => {
  assert.strictEqual(P.resolveLabel(undefined, []), 'round-1');
});

t('ignores non-numeric rounds when picking the default', () => {
  assert.strictEqual(P.resolveLabel(undefined, ['publisher/copy-edit-pass']), 'round-1');
});

console.log('\n=== readme ===');

t('names the round and lists the do-not-touch constructs', () => {
  const md = P.buildReadme({ label: 'round-1', date: '2026-09-12', edition: 'Author Preview v0.3.2', version: '0.3.2' });
  assert.ok(md.includes('round-1'));
  assert.ok(md.includes('Author Preview v0.3.2'));
  for (const construct of ['{SITE_BASE}', '{{', '{#fig:', '[@', ':::']) {
    assert.ok(md.includes(construct), `README must mention ${construct}`);
  }
  assert.ok(/do not re-?wrap|do not reflow/i.test(md), 'README must ask them not to re-wrap');
  assert.ok(md.includes('QUERIES.md'), 'README must point at QUERIES.md');
});

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
