/**
 * End-to-end tests for the publisher round-trip CLIs.
 * Run with:  node scripts/lib/publisher-roundtrip.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../package-for-publisher.js');
const B = require('./publisher-bundle.js');

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

t('throws when a label sanitizes to nothing', () => {
  assert.throws(() => P.resolveLabel('!!!', []), /no usable characters/);
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

console.log('\n=== rollback on failure ===');

t('deletes the tag it created when a source file is missing at the tag', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-rollback-'));
  const run = (args) => execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8' });

  try {
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);

    // Commit all 13 expected sources except one, so the `git show` loop inside
    // package-for-publisher.js throws partway through -- after the tag already exists.
    for (const name of B.EXPECTED_FILES) {
      if (name === 'ch9.md') continue; // deliberately missing
      fs.writeFileSync(path.join(tmpRepo, name), `# ${name}\n`, 'utf8');
    }
    run(['add', '.']);
    run(['commit', '-q', '-m', 'initial']);

    const cliPath = path.join(__dirname, '..', 'package-for-publisher.js');
    let failed = false;
    try {
      // Explicit stdio (rather than relying on execFileSync's default) fully captures
      // the child's stdout/stderr instead of also echoing stderr to this process's own
      // stderr, which would otherwise spam "fatal: ..." noise into the test output.
      execFileSync(process.execPath, [cliPath, tmpRepo, '--round', 'rollback-test'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      failed = true;
    }
    assert.ok(failed, 'expected the CLI to exit non-zero when a source file is missing at the tag');

    const tags = run(['tag', '-l', 'publisher/*']).trim();
    assert.strictEqual(tags, '', 'expected no publisher/* tag left behind after a failed package run');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
