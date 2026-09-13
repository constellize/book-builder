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

console.log('\n=== fingerprint ===');

const FIXTURE = [
  '# Chapter Title',
  '',
  'Prose with a {SITE_BASE} link and a [@atkinson2026] citation.',
  '',
  '![A diagram of the thing](images/diagrams/ch3/thing.png){#fig:thing}',
  '',
  '::: {.promptref title="Constellation Mapping" url="{SITE_BASE}/prompts/v1/constellation-map"}',
  'Map trusted components for {{system_name}}.',
  ':::',
  '',
  '::: info',
  'An informational callout.',
  ':::',
  '',
  '```bash',
  '# this is a comment, not a heading',
  'echo "{SITE_BASE} is not a placeholder in here"',
  '```',
  '',
  '## Section Two',
].join('\n');

t('counts only real headings and records their levels', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).headingLevels, [1, 2]);
});

t('counts placeholders outside code, including inside div fence attributes', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).placeholders, { '{SITE_BASE}': 2 });
});

t('counts template vars', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).templateVars, { '{{system_name}}': 1 });
});

t('records attribute blocks but not div fence attributes', () => {
  // The promptref attribute contains a nested brace pair, so a naive {...} scan
  // truncates it. Div fence lines are compared verbatim instead.
  assert.deepStrictEqual(G.fingerprint(FIXTURE).attrBlocks, { '{#fig:thing}': 1 });
});

t('records image paths but not alt text', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).imagePaths, {
    'images/diagrams/ch3/thing.png': 1,
  });
});

t('records citation keys', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).citations, { atkinson2026: 1 });
});

t('extracts multiple citation keys from one bracket span', () => {
  assert.deepStrictEqual(G.fingerprint('See [@one; @two].').citations, { one: 1, two: 1 });
});

t('records div fence lines verbatim and in order', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).divFences, [
    '::: {.promptref title="Constellation Mapping" url="{SITE_BASE}/prompts/v1/constellation-map"}',
    ':::',
    '::: info',
    ':::',
  ]);
});

t('records code fence lines and block contents', () => {
  const fp = G.fingerprint(FIXTURE);
  assert.deepStrictEqual(fp.codeFences, ['```bash', '```']);
  assert.strictEqual(fp.codeBlocks.length, 1);
  assert.ok(fp.codeBlocks[0].includes('# this is a comment'));
});

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
