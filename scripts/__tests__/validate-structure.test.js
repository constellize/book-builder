const { findStrandableBlocks } = require('../validate-structure');

test('flags a bold-only paragraph on its own line', () => {
  expect(findStrandableBlocks('**Day 1: Create Your First Memory Bank**\n\nStart small.\n', 'ch9.md'))
    .toEqual([{file: 'ch9.md', line: 1, text: 'Day 1: Create Your First Memory Bank'}]);
});

test('does not flag a run-in bold lead', () => {
  expect(findStrandableBlocks('**Day 1: x** Start small and keep going.\n', 'ch9.md')).toEqual([]);
});

test('ignores bold lines inside fenced code', () => {
  expect(findStrandableBlocks('```\n**not markdown**\n```\n', 'ch9.md')).toEqual([]);
});

test('does not flag a bold line that is part of a multi-line paragraph', () => {
  expect(findStrandableBlocks('Intro\n**Bold**\nmore text\n', 'a.md')).toEqual([]);
});

describe('fenced code (blank lines inside the fence, so only fence tracking can exclude)', () => {
  const cases = {
    backticks: '```\n\n**x**\n\n```\n',
    tildes: '~~~\n\n**x**\n\n~~~\n',
    'info string': '```{.md}\n\n**x**\n\n```\n',
    '4-backtick fence containing a 3-backtick line': '````\n\n**x**\n\n```\n\n**y**\n\n````\n',
  };
  for (const [name, md] of Object.entries(cases)) {
    test(name, () => expect(findStrandableBlocks(md, 'a.md')).toEqual([]));
  }
  test('bold after the fence closes is flagged again', () => {
    expect(findStrandableBlocks('```\n\n```\n\n**x**\n\n', 'a.md')).toEqual([{file: 'a.md', line: 5, text: 'x'}]);
  });
});

describe('paragraph boundaries', () => {
  test('bold directly after an ATX heading', () => {
    expect(findStrandableBlocks('## H\n**Label**\n\ntext\n', 'a.md')).toEqual([{file: 'a.md', line: 2, text: 'Label'}]);
  });
  test('bold directly after a fence close and a ::: line', () => {
    expect(findStrandableBlocks('```\ncode\n```\n**A**\n\n::: {.x}\n**B**\n\ntext\n:::\n', 'a.md').map(b => b.text)).toEqual(['A', 'B']);
  });
  test('bold directly before a heading', () => {
    expect(findStrandableBlocks('text\n\n**Label**\n# H\n', 'a.md').map(b => b.text)).toEqual(['Label']);
  });
});

describe('forms of one-line bold', () => {
  test.each([
    ['**Label**:', 'Label'], ['**Label**.', 'Label'], ['***Label***', 'Label'],
    ['__Label__', 'Label'], ['**Label:**', 'Label:'],
  ])('%s', (src, text) => {
    expect(findStrandableBlocks(`${src}\n\ntext\n`, 'a.md')).toEqual([{file: 'a.md', line: 1, text}]);
  });
  test('two bold spans on one line is not one span', () => {
    expect(findStrandableBlocks('**a** and **b**\n\n', 'a.md')).toEqual([]);
  });
  test('bold in blockquotes and list items is excluded by design', () => {
    expect(findStrandableBlocks('> **For Prompt Storage:**\n\n- **item**\n\n', 'a.md')).toEqual([]);
  });
});

test('a configured literal source path that does not exist is reported as missing', () => {
  const { manuscriptFiles } = require('../validate-structure');
  const r = manuscriptFiles({ source: { root: __dirname, foreword: 'no-such-file.md', chapters: ['validate-structure.test.js'] } });
  expect(r.missing).toEqual(['no-such-file.md']);
  expect(r.files.length).toBe(1);
});
