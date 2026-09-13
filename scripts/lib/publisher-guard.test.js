/**
 * Tests for publisher-guard.js. Run with:  node scripts/lib/publisher-guard.test.js
 */
const assert = require('assert');
const G = require('./publisher-guard.js');

let n = 0, f = 0;
const t = (name, fn) => { n++; try { fn(); console.log('  [ OK ] ' + name); } catch (e) { f++; console.log('  [FAIL] ' + name + ' -- ' + e.message); } };

const kinds = (text) => G.tokenize(text).lines.map((l) => l.kind);

console.log('=== tokenizer ===');

t('classifies a plain paragraph as text', () => {
  assert.deepStrictEqual(kinds('hello world'), ['text']);
});

t('classifies an ATX heading as heading', () => {
  assert.deepStrictEqual(kinds('# Title'), ['heading']);
});

t('treats # inside a fenced code block as code, not a heading', () => {
  const text = '```bash\n# not a heading\n```';
  assert.deepStrictEqual(kinds(text), ['code-fence', 'code', 'code-fence']);
});

t('classifies ::: fences and tracks div depth', () => {
  const text = '::: info\nbody\n:::';
  const lines = G.tokenize(text).lines;
  assert.deepStrictEqual(lines.map((l) => l.kind), ['div-fence', 'text', 'div-fence']);
  assert.strictEqual(lines[1].divDepth, 1, 'body is inside the div');
  assert.strictEqual(lines[2].divDepth, 0, 'closer returns to depth 0');
});

t('classifies list items and their indented continuation', () => {
  const text = '- item\n  continued\n\nparagraph';
  assert.deepStrictEqual(kinds(text), ['list', 'list', 'blank', 'text']);
});

t('classifies checkbox list items as list', () => {
  assert.deepStrictEqual(kinds('- [ ] Is this proven?'), ['list']);
});

t('classifies pipe table rows as table', () => {
  assert.deepStrictEqual(kinds('| a | b |'), ['table']);
});

t('classifies a four-space indented block as code', () => {
  assert.deepStrictEqual(kinds('para\n\n    indented code'), ['text', 'blank', 'code']);
});

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
