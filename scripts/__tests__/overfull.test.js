const { parseOverfullVboxes } = require('../verify-pdf');

test('extracts page and overflow size from Overfull \\vbox warnings', () => {
  const log = `Overfull \\vbox (12.5pt too high) has occurred while \\output is active [184]`;
  expect(parseOverfullVboxes(log)).toEqual([{ page: 184, points: 12.5 }]);
});

test('ignores Overfull \\hbox lines', () => {
  expect(parseOverfullVboxes('Overfull \\hbox (3.0pt too wide) in paragraph at lines 1--2')).toEqual([]);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readOverfullVboxes } = require('../verify-pdf');

describe('readOverfullVboxes', () => {
  let dir, pdf, log;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overfull-'));
    pdf = path.join(dir, 'b.pdf'); log = path.join(dir, 'b.xelatex.log');
    fs.writeFileSync(pdf, '%PDF');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a missing log is NOT MEASURED, never an empty (clean) result', () => {
    const r = readOverfullVboxes(pdf);
    expect(r.measured).toBe(false);
    expect(r.boxes).toBeUndefined();
  });

  test('a log older than the PDF is not measured', () => {
    fs.writeFileSync(log, 'Overfull \\vbox (9.0pt too high) has occurred while \\output is active [3]');
    const old = new Date(Date.now() - 3600e3);
    fs.utimesSync(log, old, old);
    expect(readOverfullVboxes(pdf).measured).toBe(false);
  });

  test('a current log is parsed', () => {
    fs.writeFileSync(log, 'Overfull \\vbox (9.0pt too high) has occurred while \\output is active [3]');
    expect(readOverfullVboxes(pdf)).toMatchObject({ measured: true, boxes: [{ page: 3, points: 9 }] });
  });
});

test('a warning with no page number is returned with page null, not dropped', () => {
  expect(parseOverfullVboxes('Overfull \\vbox (3.5pt too high) detected at line 42'))
    .toEqual([{ page: null, points: 3.5 }]);
});

// Against GENUINE xelatex output. Synthetic strings cannot prove the parser matches what
// TeX emits; this one failed on the first real log (empty "[]" instead of "[184]").
const { spawnSync } = require('child_process');
const TEX_BIN = '/usr/local/texlive/2025/bin/universal-darwin:/usr/local/texlive/2024/bin/universal-darwin';
const env = { ...process.env, PATH: `${process.env.PATH}:${TEX_BIN}` };
const hasXelatex = !spawnSync('xelatex', ['--version'], { env }).error;

(hasXelatex ? test : test.skip)('parses a real xelatex log that overflows page 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overfull-tex-'));
  try {
    const fx = path.join(__dirname, 'fixtures', 'overfull-vbox.tex');
    const r = spawnSync('xelatex', ['-interaction=nonstopmode', `-output-directory=${dir}`, fx],
      { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const logText = fs.readFileSync(path.join(dir, 'overfull-vbox.log'), 'utf8');
    expect(logText).toMatch(/Overfull \\vbox/); // the fixture really did overflow
    const boxes = parseOverfullVboxes(logText);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].page).toBe(2);
    expect(boxes[0].points).toBeCloseTo(141.8, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
