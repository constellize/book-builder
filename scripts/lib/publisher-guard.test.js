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

console.log('\n=== rules ===');

const compare = (before, after, extra = {}) =>
  G.compareFiles({ name: 'ch3.md', snapshotText: before, returnedText: after, notes: {}, refKeys: null, ...extra });
const rules = (findings) => findings.map((x) => x.rule).sort();

t('an edit that only changes prose produces no findings', () => {
  assert.deepStrictEqual(compare(FIXTURE, FIXTURE.replace('Prose with', 'Prose containing')), []);
});

t('editing image alt text is allowed', () => {
  const after = FIXTURE.replace('A diagram of the thing', 'A diagram of the widget');
  assert.deepStrictEqual(compare(FIXTURE, after), []);
});

t('a reworded div fence attribute is a fence-integrity error', () => {
  const after = FIXTURE.replace('title="Constellation Mapping"', 'title="Constellation Map"');
  const found = compare(FIXTURE, after);
  assert.deepStrictEqual(rules(found), ['fence-integrity']);
  assert.strictEqual(found[0].severity, 'error');
});

t('a deleted div closer is a fence-integrity error', () => {
  const after = FIXTURE.replace('An informational callout.\n:::', 'An informational callout.');
  assert.ok(rules(compare(FIXTURE, after)).includes('fence-integrity'));
});

t('a removed placeholder is a placeholder-tokens error', () => {
  const after = FIXTURE.replace('a {SITE_BASE} link', 'a link');
  const found = compare(FIXTURE, after);
  assert.deepStrictEqual(rules(found), ['placeholder-tokens']);
  assert.strictEqual(found[0].severity, 'error');
});

t('a reworded template var is a template-vars error', () => {
  const after = FIXTURE.replace('{{system_name}}', '{{the system name}}');
  assert.deepStrictEqual(rules(compare(FIXTURE, after)), ['template-vars']);
});

t('a dropped figure attribute is an attr-blocks error', () => {
  const after = FIXTURE.replace('{#fig:thing}', '');
  assert.deepStrictEqual(rules(compare(FIXTURE, after)), ['attr-blocks']);
});

t('a changed image path is an image-paths error', () => {
  const after = FIXTURE.replace('thing.png', 'things.png');
  assert.deepStrictEqual(rules(compare(FIXTURE, after)), ['image-paths']);
});

t('a changed citation key is a citations error', () => {
  const after = FIXTURE.replace('atkinson2026', 'atkinson2027');
  assert.deepStrictEqual(rules(compare(FIXTURE, after)), ['citations']);
});

t('an unresolvable citation key is an error even when the multiset is unchanged', () => {
  const found = compare(FIXTURE, FIXTURE, { refKeys: new Set(['somethingElse']) });
  assert.deepStrictEqual(rules(found), ['citations']);
  assert.ok(found[0].message.includes('atkinson2026'));
});

t('a broken code fence is a code-fence-integrity error', () => {
  const after = FIXTURE.replace('```bash', '```sh');
  assert.deepStrictEqual(rules(compare(FIXTURE, after)), ['code-fence-integrity']);
});

t('demoting a heading is a heading-structure warning, not an error', () => {
  const after = FIXTURE.replace('## Section Two', '### Section Two');
  const found = compare(FIXTURE, after);
  assert.deepStrictEqual(rules(found), ['heading-structure']);
  assert.strictEqual(found[0].severity, 'warning');
  assert.strictEqual(G.hasErrors(found), false);
});

t('retitling a heading produces no findings', () => {
  assert.deepStrictEqual(compare(FIXTURE, FIXTURE.replace('## Section Two', '## Section Deux')), []);
});

t('editing inside a code block is a code-content warning', () => {
  const after = FIXTURE.replace('# this is a comment', '# This is a comment');
  const found = compare(FIXTURE, after);
  assert.deepStrictEqual(rules(found), ['code-content']);
  assert.strictEqual(found[0].severity, 'warning');
});

t('invalid UTF-8 is an encoding error and suppresses other rules', () => {
  const found = compare(FIXTURE, FIXTURE, { notes: { invalidUtf8: true } });
  assert.deepStrictEqual(rules(found), ['encoding']);
  assert.strictEqual(found[0].severity, 'error');
});

t('a stripped BOM and CRLF are line-endings warnings, not errors', () => {
  const found = compare(FIXTURE, FIXTURE, { notes: { hadBom: true, hadCrlf: true } });
  assert.deepStrictEqual(rules(found), ['line-endings']);
  assert.strictEqual(G.hasErrors(found), false);
});

t('a large rewrite is a change-volume warning', () => {
  const before = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
  const after = Array.from({ length: 10 }, (_, i) => `Rewritten ${i}.`).join('\n\n');
  assert.ok(rules(compare(before, after)).includes('change-volume'));
});

console.log('\n=== file set ===');

const EXPECTED = ['foreword-faq.md', 'introduction.md', 'ch1.md', 'appA.md'];

t('an exact file set produces no findings', () => {
  assert.deepStrictEqual(G.checkFileSet(EXPECTED, EXPECTED.slice()), []);
});

t('a missing file is a file-set error', () => {
  const found = G.checkFileSet(EXPECTED, ['foreword-faq.md', 'introduction.md', 'ch1.md']);
  assert.deepStrictEqual(rules(found), ['file-set']);
  assert.ok(found[0].message.includes('appA.md'));
});

t('an added file is a file-set error', () => {
  const found = G.checkFileSet(EXPECTED, EXPECTED.concat('ch1-edited.md'));
  assert.deepStrictEqual(rules(found), ['file-set']);
  assert.ok(found[0].message.includes('ch1-edited.md'));
});

t('bundle metadata files are not treated as additions', () => {
  const actual = EXPECTED.concat(['README.md', 'MANIFEST.TXT', 'QUERIES.md']);
  assert.deepStrictEqual(G.checkFileSet(EXPECTED, actual), []);
});

console.log('\n=== report ===');

t('renders a summary table and per-file findings', () => {
  const md = G.renderReport(compare(FIXTURE, FIXTURE.replace('thing.png', 'things.png')));
  assert.ok(md.includes('| ch3.md |'), 'summary row present');
  assert.ok(md.includes('image-paths'), 'rule named');
  assert.ok(md.includes('things.png'), 'offending token shown');
});

t('renders a clean report when there are no findings', () => {
  const md = G.renderReport([]);
  assert.ok(/no structural changes/i.test(md));
});

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
