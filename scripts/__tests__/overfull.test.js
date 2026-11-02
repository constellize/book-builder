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
