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
