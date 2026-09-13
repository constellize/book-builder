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

console.log('\n=== apply CLI loads ===');

t('apply-publisher-edits exposes its exit codes', () => {
  const A = require('../apply-publisher-edits.js');
  assert.deepStrictEqual(A.EXIT, { OK: 0, BLOCKED: 1, CONFLICTS: 2 });
});

console.log('\n=== apply: rollback on write failure ===');

t('deletes the edit branch and restores the original branch when a returned file cannot be written', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-apply-rollback-'));
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-apply-rollback-bundle-'));
  const run = (args) => execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8' });
  const originalText = (name) => `# ${name}\n\nOriginal paragraph text for ${name}.\n`;

  try {
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);

    for (const name of B.EXPECTED_FILES) {
      fs.writeFileSync(path.join(tmpRepo, name), originalText(name), 'utf8');
    }
    run(['add', '.']);
    run(['commit', '-q', '-m', 'initial']);
    const originalBranch = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

    const label = 'rollback-write-test';
    const tag = `publisher/${label}`;
    run(['tag', tag]);
    const commit = run(['rev-parse', `${tag}^{commit}`]).trim();

    // MANIFEST.TXT must describe the SNAPSHOT (the tag's content), never the returned
    // files -- verifyManifest checks it against `git show <tag>:<file>`, so every hash
    // here is of the original, unedited text, even for ch5.md below.
    const files = B.EXPECTED_FILES.map((name) => ({ name, sha256: B.sha256(originalText(name)) }));
    fs.writeFileSync(path.join(bundleDir, 'MANIFEST.TXT'),
      B.renderManifest({ label, tag, commit, date: '2026-01-01', files }), 'utf8');

    // The returned bundle itself carries an edit to ch5.md, so apply finds a real diff
    // and proceeds to stage and commit it, rather than short-circuiting on "identical to
    // the snapshot."
    for (const name of B.EXPECTED_FILES) {
      const content = name === 'ch5.md' ? `# ch5\n\nEdited paragraph text for ch5.\n` : originalText(name);
      fs.writeFileSync(path.join(bundleDir, name), content, 'utf8');
    }

    // Make the live ch5.md unwritable. HEAD is still exactly the tag's commit, so
    // `git checkout -b <tag>-edits <tag>` inside apply is a same-content checkout and
    // does not reset the file's mode -- the permission survives onto the new branch,
    // where apply's write loop reaches ch5.md (the 8th of 13 files) and fails with
    // EACCES, after several earlier files have already been overwritten uncommitted.
    const liveFile = path.join(tmpRepo, 'ch5.md');
    fs.chmodSync(liveFile, 0o444);

    const applyCli = path.join(__dirname, '..', 'apply-publisher-edits.js');
    let failed = false;
    try {
      execFileSync(process.execPath, [applyCli, bundleDir, '--content-dir', tmpRepo], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      failed = true;
    } finally {
      fs.chmodSync(liveFile, 0o644); // restore so cleanup below can remove the repo
    }
    assert.ok(failed, 'expected apply-publisher-edits to exit non-zero when a returned file cannot be written');

    const editBranches = run(['branch', '--list', `${tag}-edits`]).trim();
    assert.strictEqual(editBranches, '', 'expected no edit branch left behind after a failed apply');

    const currentBranch = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    assert.strictEqual(currentBranch, originalBranch, 'expected HEAD to be back on the original branch');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
});

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
