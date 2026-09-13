/**
 * End-to-end tests for the publisher round-trip CLIs.
 * Run with:  node scripts/lib/publisher-roundtrip.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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
    let status = null;
    try {
      execFileSync(process.execPath, [applyCli, bundleDir, '--content-dir', tmpRepo], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = err.status;
    } finally {
      fs.chmodSync(liveFile, 0o644); // restore so cleanup below can remove the repo
    }
    // The contract hangs on the specific code, not just "non-zero": EXIT.BLOCKED (1)
    // means a precondition or guard failure with nothing of value left behind.
    assert.strictEqual(status, 1, 'expected apply-publisher-edits to exit 1 when a returned file cannot be written');

    const editBranches = run(['branch', '--list', `${tag}-edits`]).trim();
    assert.strictEqual(editBranches, '', 'expected no edit branch left behind after a failed apply');

    const currentBranch = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    assert.strictEqual(currentBranch, originalBranch, 'expected HEAD to be back on the original branch');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
});

console.log('\n=== apply: detached HEAD ===');

t('refuses to run on a detached HEAD and creates no edit branch', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-apply-detached-'));
  const run = (args) => execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8' });

  try {
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);

    for (const name of B.EXPECTED_FILES) {
      fs.writeFileSync(path.join(tmpRepo, name), `# ${name}\n\nOriginal paragraph text for ${name}.\n`, 'utf8');
    }
    run(['add', '.']);
    run(['commit', '-q', '-m', 'initial']);

    const packageCli = path.join(__dirname, '..', 'package-for-publisher.js');
    execFileSync(process.execPath, [packageCli, tmpRepo, '--round', 'detached-test'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });

    // `git checkout <sha>` (rather than a branch name) detaches HEAD, exactly as
    // `git checkout publisher/detached-test` would to look at an earlier round.
    const sha = run(['rev-parse', 'HEAD']).trim();
    run(['checkout', '-q', sha]);
    assert.strictEqual(run(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'HEAD', 'test setup: expected HEAD to be detached');

    const bundleDir = path.join(tmpRepo, 'publisher', 'detached-test', 'outgoing', 'constellize-book-detached-test');
    const applyCli = path.join(__dirname, '..', 'apply-publisher-edits.js');
    let status = null;
    let stderr = '';
    try {
      execFileSync(process.execPath, [applyCli, bundleDir, '--content-dir', tmpRepo], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = err.status;
      stderr = String(err.stderr || '');
    }
    assert.strictEqual(status, 1, 'expected exit 1 when HEAD is detached');
    assert.ok(/detached/i.test(stderr), `expected the error to name the detached HEAD, got: ${stderr}`);

    const editBranches = run(['branch', '--list', 'publisher/*-edits']).trim();
    assert.strictEqual(editBranches, '', 'expected no edit branch to be created when HEAD is detached');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

console.log('\n=== apply: does not self-block on its own workspace ===');

t('does not treat its own untracked publisher/ workspace as a dirty tree', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-apply-selfblock-'));
  const run = (args) => execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8' });

  try {
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);

    for (const name of B.EXPECTED_FILES) {
      fs.writeFileSync(path.join(tmpRepo, name), `# ${name}\n\nOriginal paragraph text for ${name}.\n`, 'utf8');
    }
    run(['add', '.']);
    run(['commit', '-q', '-m', 'initial']);

    const packageCli = path.join(__dirname, '..', 'package-for-publisher.js');
    execFileSync(process.execPath, [packageCli, tmpRepo, '--round', 'selfblock-test'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Simulate the packager's own untracked scratch output sitting in the tree -- the
    // exact shape that used to trip the dirty-tree check before this fix, whether it
    // came from this round or an unrelated one.
    fs.mkdirSync(path.join(tmpRepo, 'publisher', 'round-1', 'outgoing'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'publisher', 'round-1', 'outgoing', 'x.txt'), 'noise\n', 'utf8');

    const bundleDir = path.join(tmpRepo, 'publisher', 'selfblock-test', 'outgoing', 'constellize-book-selfblock-test');
    const applyCli = path.join(__dirname, '..', 'apply-publisher-edits.js');
    let status = null;
    let stderr = '';
    try {
      execFileSync(process.execPath, [applyCli, bundleDir, '--content-dir', tmpRepo], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      status = 0;
    } catch (err) {
      status = err.status;
      stderr = String(err.stderr || '');
    }
    assert.strictEqual(status, 0, `expected a clean apply to succeed despite untracked publisher/ noise, got status ${status}: ${stderr}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

console.log('\n=== apply: scratch directory cleanup ===');

t('removes its scratch unpack directory after a run', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-apply-scratchcheck-'));
  const run = (args) => execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8' });

  // Matches exactly what fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-apply-'))
  // produces: the literal prefix plus exactly 6 trailing characters, nothing more. This
  // is deliberately narrower than a bare "starts with publisher-apply-" check, which
  // would also match this very test file's own 'publisher-apply-scratchcheck-*' and
  // 'publisher-apply-rollback-*' fixture directories above.
  const SCRATCH_RE = /^publisher-apply-[A-Za-z0-9]{6}$/;
  const countScratchDirs = () => fs.readdirSync(os.tmpdir()).filter((name) => SCRATCH_RE.test(name)).length;

  try {
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);

    for (const name of B.EXPECTED_FILES) {
      fs.writeFileSync(path.join(tmpRepo, name), `# ${name}\n\nOriginal paragraph text for ${name}.\n`, 'utf8');
    }
    run(['add', '.']);
    run(['commit', '-q', '-m', 'initial']);

    const packageCli = path.join(__dirname, '..', 'package-for-publisher.js');
    execFileSync(process.execPath, [packageCli, tmpRepo, '--round', 'scratch-check'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });

    const before = countScratchDirs();

    const bundleDir = path.join(tmpRepo, 'publisher', 'scratch-check', 'outgoing', 'constellize-book-scratch-check');
    const applyCli = path.join(__dirname, '..', 'apply-publisher-edits.js');
    execFileSync(process.execPath, [applyCli, bundleDir, '--content-dir', tmpRepo, '--dry-run'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });

    const after = countScratchDirs();
    assert.strictEqual(after, before, 'expected no leftover publisher-apply-* scratch directory after a run');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

console.log('\n=== apply: re-running an already-applied round preserves change-report.md ===');

t('does not destroy a prior change-report.md when a re-run is blocked by the branch-exists guard', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-apply-rerun-'));
  const run = (args) => execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8' });
  const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  try {
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);

    for (const name of B.EXPECTED_FILES) {
      fs.writeFileSync(path.join(tmpRepo, name), `# ${name}\n\nOriginal paragraph text for ${name}.\n`, 'utf8');
    }
    run(['add', '.']);
    run(['commit', '-q', '-m', 'initial']);

    const packageCli = path.join(__dirname, '..', 'package-for-publisher.js');
    execFileSync(process.execPath, [packageCli, tmpRepo, '--round', 'rerun-test'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });

    const bundleDir = path.join(tmpRepo, 'publisher', 'rerun-test', 'outgoing', 'constellize-book-rerun-test');
    fs.writeFileSync(path.join(bundleDir, 'ch2.md'),
      fs.readFileSync(path.join(bundleDir, 'ch2.md'), 'utf8').replace('Original', 'Edited'), 'utf8');

    const applyCli = path.join(__dirname, '..', 'apply-publisher-edits.js');
    execFileSync(process.execPath, [applyCli, bundleDir, '--content-dir', tmpRepo], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });

    const changeReportPath = path.join(tmpRepo, 'publisher', 'rerun-test', 'incoming', 'change-report.md');
    assert.ok(fs.existsSync(changeReportPath), 'expected the first, successful apply to produce change-report.md');
    const before = sha256(changeReportPath);

    // editBranch survives a successful merge by design, so re-running the same round --
    // even against the identical, already-merged bundle -- lands on the branch-exists
    // guard. That is the ordinary shape of a re-run, not an exotic setup.
    let status = null;
    let stderr = '';
    try {
      execFileSync(process.execPath, [applyCli, bundleDir, '--content-dir', tmpRepo], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = err.status;
      stderr = String(err.stderr || '');
    }
    assert.strictEqual(status, 1, `expected the re-run to fail at the branch-exists guard, got status ${status}: ${stderr}`);
    assert.ok(/already exists/.test(stderr), `expected the branch-exists error, got: ${stderr}`);

    assert.ok(fs.existsSync(changeReportPath), 'expected change-report.md to survive a re-run blocked by the branch-exists guard');
    assert.strictEqual(sha256(changeReportPath), before, 'expected change-report.md to be byte-identical after the blocked re-run');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
