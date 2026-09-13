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

t('treats up to three leading spaces as a heading, as pandoc does', () => {
  assert.deepStrictEqual(kinds('   # Title'), ['heading']);
});

t('treats a four-space indented heading as code, as pandoc does', () => {
  assert.deepStrictEqual(kinds('    # Title'), ['code']);
});

t('treats a tab-indented line as code, as pandoc does', () => {
  assert.deepStrictEqual(kinds('\t# Title'), ['code']);
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

// Counters map token -> the 1-based lines it was found on, so the count is the array
// length and the report can say where to look.
t('counts placeholders outside code, including inside div fence attributes', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).placeholders, { '{SITE_BASE}': [3, 7] });
});

t('counts template vars', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).templateVars, { '{{system_name}}': [8] });
});

t('records attribute blocks but not div fence attributes', () => {
  // The promptref attribute contains a nested brace pair, so a naive {...} scan
  // truncates it. Div fence lines are compared verbatim instead.
  assert.deepStrictEqual(G.fingerprint(FIXTURE).attrBlocks, { '{#fig:thing}': [5] });
});

t('records image paths but not alt text', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).imagePaths, {
    'images/diagrams/ch3/thing.png': [5],
  });
});

t('records citation keys', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).citations, { atkinson2026: [3] });
});

t('extracts multiple citation keys from one bracket span', () => {
  assert.deepStrictEqual(G.fingerprint('See [@one; @two].').citations, { one: [1], two: [1] });
});

t('records div fence lines with their leading indentation and line numbers', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).divFences, [
    { text: '::: {.promptref title="Constellation Mapping" url="{SITE_BASE}/prompts/v1/constellation-map"}', n: 7 },
    { text: ':::', n: 9 },
    { text: '::: info', n: 11 },
    { text: ':::', n: 13 },
  ]);
});

t('keeps a fence line\'s leading whitespace but drops its trailing whitespace', () => {
  const fp = G.fingerprint('    ::: info  \nbody\n:::\n');
  assert.strictEqual(fp.divFences[0].text, '    ::: info', 'indentation survives, trailing space does not');
});

t('records code fence lines and block contents', () => {
  const fp = G.fingerprint(FIXTURE);
  assert.deepStrictEqual(fp.codeFences, [{ text: '```bash', n: 15 }, { text: '```', n: 18 }]);
  assert.strictEqual(fp.codeBlocks.length, 1);
  assert.ok(fp.codeBlocks[0].includes('# this is a comment'));
});

t('records a heading indented into code, and does not mistake code comments for one', () => {
  assert.deepStrictEqual(G.fingerprint(FIXTURE).indentedHeadings, {},
    'the # comment inside the ```bash block is not an indented heading');
  assert.deepStrictEqual(G.fingerprint('para\n\n    ## Section Two\n').indentedHeadings,
    { '    ## Section Two': [3] });
});

t('does not carry an unused lineCount field', () => {
  assert.ok(!('lineCount' in G.fingerprint(FIXTURE)));
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

// The four cases below are the failure the whole feature exists to prevent. Indenting a
// fence stops pandoc seeing it at all -- an indented promptref renders as a stray code
// block plus a paragraph ending in ':::' and the callout is gone -- and before these
// tests the guard reported nothing whatsoever, because the fingerprint .trim()ed the
// indentation away before anything was compared.
t('an indented ::: opener is a fence-integrity error', () => {
  const after = FIXTURE.replace('::: {.promptref', '    ::: {.promptref');
  const found = compare(FIXTURE, after);
  assert.deepStrictEqual(rules(found), ['fence-integrity']);
  assert.strictEqual(found[0].severity, 'error');
  assert.ok(/line 7/.test(found[0].detail), `detail should locate the fence, got: ${found[0].detail}`);
});

t('an indented ::: closer is a fence-integrity error', () => {
  const after = FIXTURE.replace('An informational callout.\n:::', 'An informational callout.\n    :::');
  const found = compare(FIXTURE, after);
  assert.deepStrictEqual(rules(found), ['fence-integrity']);
  assert.strictEqual(found[0].severity, 'error');
});

t('an indented ``` fence is a code-fence-integrity error', () => {
  const after = FIXTURE.replace('```bash', '    ```bash');
  const found = compare(FIXTURE, after);
  assert.ok(rules(found).includes('code-fence-integrity'));
  assert.strictEqual(found.find((x) => x.rule === 'code-fence-integrity').severity, 'error');
});

t('an indented heading is a heading-structure error, not just a warning', () => {
  const after = FIXTURE.replace('## Section Two', '    ## Section Two');
  const found = compare(FIXTURE, after);
  assert.deepStrictEqual([...new Set(rules(found))], ['heading-structure']);
  assert.strictEqual(G.hasErrors(found), true, 'an indented heading must block the merge');
  const error = found.find((x) => x.severity === 'error');
  assert.ok(/indented/.test(error.message), `message should say indented, got: ${error.message}`);
  assert.ok(/line 20/.test(error.detail), `detail should locate the heading, got: ${error.detail}`);
});

t('a heading indented by three spaces is still a heading and produces no findings', () => {
  // Pandoc accepts up to three leading spaces. Only four or more destroys the heading.
  assert.deepStrictEqual(compare(FIXTURE, FIXTURE.replace('## Section Two', '   ## Section Two')), []);
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

t('an unresolvable citation key the publisher introduced is a citations error', () => {
  const after = FIXTURE.replace('atkinson2026', 'atkinson2027');
  const found = compare(FIXTURE, after, { refKeys: new Set(['atkinson2026']) });
  assert.deepStrictEqual(rules(found), ['citations', 'citations']);
  assert.strictEqual(G.hasErrors(found), true);
  assert.ok(found.some((x) => x.severity === 'error' && x.message.includes('atkinson2027')));
});

t('an unresolvable key on an unchanged citation multiset is a warning naming the real cause', () => {
  // refKeys is read from the WORKING TREE's references.json. When the returned
  // citations are identical to the snapshot's, the publisher cannot have caused this:
  // the author removed or renamed the reference while the round was out. Blocking at
  // error would force --force, which switches off every error rule at once.
  const found = compare(FIXTURE, FIXTURE, { refKeys: new Set(['somethingElse']) });
  assert.deepStrictEqual(rules(found), ['citations']);
  assert.strictEqual(found[0].severity, 'warning');
  assert.strictEqual(G.hasErrors(found), false, 'an author-side reference change must not block the merge');
  assert.ok(found[0].message.includes('atkinson2026'));
  assert.ok(/references\.json/.test(found[0].message));
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
  assert.deepStrictEqual(rules(compare(before, after)), ['change-volume']);
});

t('blank lines do not dilute change-volume below the threshold', () => {
  // 10 paragraphs separated by blank lines, half rewritten. Counting blank lines in
  // the denominator (the old, buggy behaviour) gives 5/19 = 0.26 -- under threshold,
  // so the warning would not have fired. Excluding blanks gives 5/10 = 0.5.
  const before = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
  const after = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? `Rewritten ${i}.` : `Paragraph ${i}.`)).join('\n\n');
  assert.deepStrictEqual(rules(compare(before, after)), ['change-volume']);
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

console.log('\n=== line numbers in findings ===');

t('a counter-rule message says which lines held the token before and after', () => {
  const before = 'A {SITE_BASE} link.\n\nAnother {SITE_BASE} link.\n';
  const after = 'A {SITE_BASE} link.\n\nAnother link.\n';
  const found = compare(before, after).find((x) => x.rule === 'placeholder-tokens');
  assert.ok(found, 'placeholder-tokens must fire');
  assert.ok(/was lines 1, 3/.test(found.message), `expected before-lines, got: ${found.message}`);
  assert.ok(/now line 1/.test(found.message), `expected after-lines, got: ${found.message}`);
});

t('a removed token reports the lines it used to sit on', () => {
  const found = compare(FIXTURE, FIXTURE.replace('{#fig:thing}', ''));
  assert.ok(/was ×1 at line 5/.test(found[0].message), found[0].message);
});

t('an added token reports the line it appeared on', () => {
  const found = compare(FIXTURE, FIXTURE.replace('## Section Two', '## Section Two {{new_var}}'));
  assert.ok(/now ×1 at line 20/.test(found[0].message), found[0].message);
});

t('caps the line list rather than dumping every occurrence', () => {
  const before = Array.from({ length: 9 }, () => 'A {SITE_BASE} link.').join('\n\n');
  const found = compare(before, 'nothing here\n');
  assert.ok(/…\+3 more/.test(found[0].message), `expected a capped list, got: ${found[0].message}`);
});

console.log('\n=== dewrap-applied ===');

t('dewrap-applied is a warning-severity rule', () => {
  assert.strictEqual(G.RULES['dewrap-applied'], 'warning');
});

t('makeFinding builds a finding whose severity comes from RULES', () => {
  const finding = G.makeFinding('ch3.md', 'dewrap-applied', 'restored line breaks on 12 paragraph(s)');
  assert.deepStrictEqual(finding, {
    file: 'ch3.md', rule: 'dewrap-applied', severity: 'warning',
    message: 'restored line breaks on 12 paragraph(s)', detail: undefined,
  });
  assert.strictEqual(G.hasErrors([finding]), false);
});

t('a dewrap-applied finding reaches the rendered report', () => {
  const md = G.renderReport([G.makeFinding('ch3.md', 'dewrap-applied', 'restored line breaks on 12 paragraph(s)')]);
  assert.ok(md.includes('dewrap-applied'), 'rule named in the report');
  assert.ok(md.includes('12 paragraph(s)'), 'count recorded in the report');
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
