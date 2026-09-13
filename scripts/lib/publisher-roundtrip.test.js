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

    // Write all 13 expected sources but commit only 12, so the `git show` loop inside
    // package-for-publisher.js throws partway through -- after the tag already exists.
    //
    // ch9.md has to exist on disk (assertSourceInventory globs the content root and
    // would otherwise stop the run before the tag is ever created, which would make
    // this test pass without exercising the rollback at all) and has to be invisible to
    // `git status` (or the dirty check would stop the run instead). An entry in
    // .git/info/exclude gives exactly that: present for glob, ignored by status,
    // absent from the commit and therefore absent from the tag.
    fs.mkdirSync(path.join(tmpRepo, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, '.git', 'info', 'exclude'), 'ch9.md\n', 'utf8');
    for (const name of B.EXPECTED_FILES) {
      fs.writeFileSync(path.join(tmpRepo, name), `# ${name}\n`, 'utf8');
    }
    run(['add', '.']);
    run(['commit', '-q', '-m', 'initial']);
    assert.strictEqual(run(['ls-files', 'ch9.md']).trim(), '', 'test setup: ch9.md must not be committed');

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

console.log('\n=== end to end ===');

// fs, os, path, execFileSync, and B are already imported at the top of this file;
// only spawnSync and SCRIPTS are new here.
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');

// Explicit stdio, not execFileSync's default: without it, a git warning on stderr
// (e.g. "re-init: ignored --initial-branch" from a stray global init.templatedir on
// some machines) leaks straight through to this process's own stderr even on
// success, which would make otherwise-clean test output noisy.
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Every other fixture in this file removes its own tmpdir in a finally block; these
// 11 cases share makeRepo() instead, so track what it creates here and sweep once at
// the end of this section rather than leaving a fresh git repo under os.tmpdir() per
// test, per run.
const e2eDirs = [];

/** A minimal book repo: 13 sources with real constructs, committed on main. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-e2e-'));
  e2eDirs.push(dir);
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'author@test']);
  sh(dir, 'git', ['config', 'user.name', 'Test Author']);

  for (const name of B.EXPECTED_FILES) {
    const slug = name.replace('.md', '');
    fs.writeFileSync(path.join(dir, name), [
      `# ${slug} title`,
      '',
      `First paragraph of ${slug} with a {SITE_BASE} link and a [@key1] citation.`,
      '',
      `![A figure for ${slug}](images/${slug}.png){#fig:${slug}}`,
      '',
      '::: info',
      `A callout in ${slug}.`,
      ':::',
      '',
      `Second paragraph of ${slug}, long enough to be worth re-wrapping in an editor.`,
      '',
    ].join('\n'), 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'references.json'),
    JSON.stringify([{ id: 'key1', type: 'book', title: 'A Source' }]), 'utf8');
  fs.writeFileSync(path.join(dir, 'metadata.yaml'), 'edition: "Test Edition"\nversion: "0.0.1"\n', 'utf8');

  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'initial']);
  return dir;
}

const pkg = (dir, label) =>
  spawnSync('node', [path.join(SCRIPTS, 'package-for-publisher.js'), dir, '--round', label], { encoding: 'utf8' });

const apply = (dir, bundle, extra = []) =>
  spawnSync('node', [path.join(SCRIPTS, 'apply-publisher-edits.js'), bundle, '--content-dir', dir, ...extra], { encoding: 'utf8' });

const bundleDirFor = (dir, label) =>
  path.join(dir, 'publisher', label, 'outgoing', `constellize-book-${label}`);

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

t('packaging refuses when a source file is dirty', () => {
  const dir = makeRepo();
  fs.appendFileSync(path.join(dir, 'ch1.md'), 'uncommitted\n');
  const out = pkg(dir, 'r1');
  assert.strictEqual(out.status, 1);
  assert.ok(/uncommitted changes/i.test(out.stderr));
});

t('packaging refuses to reuse an existing round label', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const second = pkg(dir, 'r1');
  assert.strictEqual(second.status, 1);
  assert.ok(/already exists/i.test(second.stderr));
});

t('case 1: a publisher-only edit merges cleanly', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');

  const before = read(bundle, 'ch1.md');
  const edited = before.replace('First paragraph', 'Opening paragraph');
  assert.notStrictEqual(edited, before, 'the simulated edit must actually change the text');
  fs.writeFileSync(path.join(bundle, 'ch1.md'), edited, 'utf8');

  const out = apply(dir, bundle);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  assert.ok(read(dir, 'ch1.md').includes('Opening paragraph'));
});

t('case 2: concurrent edits to different chapters both survive', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');

  // Publisher edits ch1 ...
  const ch1Before = read(bundle, 'ch1.md');
  const ch1Edited = ch1Before.replace('First paragraph', 'PUBLISHER paragraph');
  assert.notStrictEqual(ch1Edited, ch1Before, "the publisher's simulated edit must actually change the text");
  fs.writeFileSync(path.join(bundle, 'ch1.md'), ch1Edited, 'utf8');

  // ... while the author edits ch2 and commits.
  const ch2Before = read(dir, 'ch2.md');
  const ch2Edited = ch2Before.replace('First paragraph', 'AUTHOR paragraph');
  assert.notStrictEqual(ch2Edited, ch2Before, "the author's simulated edit must actually change the text");
  fs.writeFileSync(path.join(dir, 'ch2.md'), ch2Edited, 'utf8');
  sh(dir, 'git', ['commit', '-q', '-am', 'author keeps working']);

  const out = apply(dir, bundle);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  assert.ok(read(dir, 'ch1.md').includes('PUBLISHER paragraph'), "publisher's edit survived");
  assert.ok(read(dir, 'ch2.md').includes('AUTHOR paragraph'), "author's edit survived");
});

t('case 3: overlapping edits stop with conflict markers and can be undone', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');

  const bundleCh1Before = read(bundle, 'ch1.md');
  const bundleCh1Edited = bundleCh1Before.replace('First paragraph', 'PUBLISHER version');
  assert.notStrictEqual(bundleCh1Edited, bundleCh1Before, "the publisher's simulated edit must actually change the text");
  fs.writeFileSync(path.join(bundle, 'ch1.md'), bundleCh1Edited, 'utf8');

  const dirCh1Before = read(dir, 'ch1.md');
  const dirCh1Edited = dirCh1Before.replace('First paragraph', 'AUTHOR version');
  assert.notStrictEqual(dirCh1Edited, dirCh1Before, "the author's simulated edit must actually change the text");
  fs.writeFileSync(path.join(dir, 'ch1.md'), dirCh1Edited, 'utf8');
  sh(dir, 'git', ['commit', '-q', '-am', 'author edits the same paragraph']);

  const out = apply(dir, bundle);
  assert.strictEqual(out.status, 2, 'conflicts exit with code 2');
  assert.ok(read(dir, 'ch1.md').includes('<<<<<<<'), 'conflict markers present');

  sh(dir, 'git', ['merge', '--abort']);
  assert.ok(read(dir, 'ch1.md').includes('AUTHOR version'));
  assert.ok(!read(dir, 'ch1.md').includes('<<<<<<<'));
});

t('case 4: a broken ::: fence blocks the merge and leaves the repo untouched', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');
  const headBefore = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();

  const ch1Before = read(bundle, 'ch1.md');
  const ch1Edited = ch1Before.replace('::: info', '::: information');
  assert.notStrictEqual(ch1Edited, ch1Before, 'the simulated fence break must actually change the text');
  fs.writeFileSync(path.join(bundle, 'ch1.md'), ch1Edited, 'utf8');

  const out = apply(dir, bundle);
  assert.strictEqual(out.status, 1, 'guard errors exit with code 1');
  assert.strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']).trim(), headBefore, 'no commit was made');
  assert.ok(!read(dir, 'ch1.md').includes('::: information'), 'working tree untouched');

  // A regression that created the edit branch (or wrote into the tracked tree) before
  // running the guard would leave this repo dirty even though the process exits
  // BLOCKED; catch that even though today's code returns before ever branching.
  const editBranches = sh(dir, 'git', ['branch', '--list', 'publisher/*-edits']).trim();
  assert.strictEqual(editBranches, '', 'expected no edit branch to be created when blocked by the guard');
  // --untracked-files=no: publisher/ (this tool's own workspace) is untracked by
  // design and must not count as dirt here.
  assert.strictEqual(sh(dir, 'git', ['status', '--porcelain', '--untracked-files=no']).trim(), '',
    'expected the tracked tree to be clean when blocked by the guard');

  const report = fs.readFileSync(path.join(dir, 'publisher', 'r1', 'incoming', 'guard-report.md'), 'utf8');
  assert.ok(report.includes('fence-integrity'));
});

t('--force merges over guard errors and records it in the commit message', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');
  const ch1Before = read(bundle, 'ch1.md');
  const ch1Edited = ch1Before.replace('::: info', '::: information');
  assert.notStrictEqual(ch1Edited, ch1Before, 'the simulated fence break must actually change the text');
  fs.writeFileSync(path.join(bundle, 'ch1.md'), ch1Edited, 'utf8');

  const out = apply(dir, bundle, ['--force']);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  assert.ok(sh(dir, 'git', ['log', '--format=%B', '-n', '5']).includes('--force'));
  assert.ok(read(dir, 'ch1.md').includes('::: information'), 'the forced edit landed');
});

t('--dry-run reports without touching git', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');
  const headBefore = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();

  const ch1Before = read(bundle, 'ch1.md');
  const ch1Edited = ch1Before.replace('First paragraph', 'Opening paragraph');
  assert.notStrictEqual(ch1Edited, ch1Before, 'the simulated edit must actually change the text');
  fs.writeFileSync(path.join(bundle, 'ch1.md'), ch1Edited, 'utf8');

  const out = apply(dir, bundle, ['--dry-run']);
  assert.strictEqual(out.status, 0);
  assert.strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.ok(!read(dir, 'ch1.md').includes('Opening paragraph'));
  // Without this, a --dry-run that is really a silent no-op (exits 0, prints nothing,
  // runs no guard) would pass every assertion above: "the edit is absent from the
  // working tree" is exactly what doing nothing also produces. This is what actually
  // pins "reports" in the test's own name.
  assert.ok(/dry run/i.test(out.stdout), `expected dry-run output to mention the dry run, got: ${out.stdout}`);
});

t('a re-wrapped but unedited return produces nothing to merge', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');

  // Join every wrapped paragraph onto a single line, changing no words.
  for (const name of B.EXPECTED_FILES) {
    const before = read(bundle, name);
    const text = before.replace(/^(Second paragraph[^\n]*), (long[^\n]*)$/m, '$1,\n$2');
    assert.notStrictEqual(text, before, `${name}: the re-wrap fixture must actually insert a line break`);
    fs.writeFileSync(path.join(bundle, name), text, 'utf8');
  }

  const out = apply(dir, bundle);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  assert.ok(/nothing to merge/i.test(out.stdout), out.stdout);
});

t('a returned bundle missing a file is blocked by file-set', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');
  fs.unlinkSync(path.join(bundle, 'appB.md'));

  const out = apply(dir, bundle);
  assert.strictEqual(out.status, 1);
  const report = fs.readFileSync(path.join(dir, 'publisher', 'r1', 'incoming', 'guard-report.md'), 'utf8');
  assert.ok(report.includes('appB.md'));
});

t('applying a zip works the same as applying a directory', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');
  const ch1Before = read(bundle, 'ch1.md');
  const ch1Edited = ch1Before.replace('First paragraph', 'Zipped paragraph');
  assert.notStrictEqual(ch1Edited, ch1Before, 'the simulated edit must actually change the text');
  fs.writeFileSync(path.join(bundle, 'ch1.md'), ch1Edited, 'utf8');

  const outgoing = path.dirname(bundle);
  const zipPath = path.join(outgoing, 'constellize-book-r1.zip');
  fs.rmSync(zipPath, { force: true });
  // Same helper the toolchain itself uses (via package-for-publisher.js), not a
  // hand-rolled invocation that could silently drift from what B.zipDir actually does.
  B.zipDir(outgoing, 'constellize-book-r1', zipPath);

  const out = apply(dir, zipPath);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  assert.ok(read(dir, 'ch1.md').includes('Zipped paragraph'));
});

t('--round 1 in the apply CLI means the same round-1 the package CLI created', () => {
  // The package CLI normalises `--round 1` to the label round-1 and tags
  // publisher/round-1. The apply CLI used opts.round raw, so the documented escape
  // hatch for a missing MANIFEST.TXT looked for the tag publisher/1 and failed with
  // "cannot be reconstructed" while publisher/round-1 sat right there.
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, '1').status, 0);
  assert.ok(sh(dir, 'git', ['tag', '-l', 'publisher/round-1']).trim(), 'package created publisher/round-1');

  const bundle = bundleDirFor(dir, 'round-1');
  fs.writeFileSync(path.join(bundle, 'ch1.md'),
    read(bundle, 'ch1.md').replace('First paragraph', 'Escape-hatch paragraph'), 'utf8');
  fs.unlinkSync(path.join(bundle, 'MANIFEST.TXT')); // the situation --round exists for

  const out = apply(dir, bundle, ['--round', '1']);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  assert.ok(!/publisher\/1\b/.test(out.stderr), `must not look for the tag publisher/1: ${out.stderr}`);
  assert.ok(read(dir, 'ch1.md').includes('Escape-hatch paragraph'));
});

t('--dry-run prints a diff stat of the returned files against the tag', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');
  fs.writeFileSync(path.join(bundle, 'ch1.md'),
    read(bundle, 'ch1.md').replace('First paragraph', 'Opening paragraph'), 'utf8');

  const out = apply(dir, bundle, ['--dry-run']);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  assert.ok(/Returned files vs publisher\/r1/.test(out.stdout), `expected a diff header, got: ${out.stdout}`);
  assert.ok(/ch1\.md\s+\+1\s+-1/.test(out.stdout), `expected ch1.md's +/- counts, got: ${out.stdout}`);
  assert.ok(/1 file\(s\) changed, 12 unchanged/.test(out.stdout), `expected a summary line, got: ${out.stdout}`);
  // The diff must not leave anything in the book repo -- dry-run touches nothing.
  assert.strictEqual(sh(dir, 'git', ['status', '--porcelain', '--untracked-files=no']).trim(), '');
  assert.ok(!fs.existsSync(path.join(dir, 'publisher', 'r1', 'incoming')), 'no incoming/ dir on a dry run');
});

t('de-wrap is recorded in guard-report.md, not only on stdout', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');

  // Hard-wrap ch1's second paragraph without changing a word, and make a real edit to
  // ch2 so there is something to merge.
  const ch1 = read(bundle, 'ch1.md');
  const rewrapped = ch1.replace(/^(Second paragraph[^\n]*), (long[^\n]*)$/m, '$1,\n$2');
  assert.notStrictEqual(rewrapped, ch1, 'the re-wrap fixture must actually insert a line break');
  fs.writeFileSync(path.join(bundle, 'ch1.md'), rewrapped, 'utf8');
  fs.writeFileSync(path.join(bundle, 'ch2.md'),
    read(bundle, 'ch2.md').replace('First paragraph', 'Edited paragraph'), 'utf8');

  const out = apply(dir, bundle);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);

  const report = fs.readFileSync(path.join(dir, 'publisher', 'r1', 'incoming', 'guard-report.md'), 'utf8');
  assert.ok(/dewrap-applied/.test(report), `guard-report.md must record the rewrite, got:\n${report}`);
  assert.ok(/1 re-wrapped paragraph/.test(report), `guard-report.md must record the count, got:\n${report}`);
  assert.ok(/\| ch1\.md \| 0 \| 1 \|/.test(report), `the summary table must count it as a warning, got:\n${report}`);
});

t('an untouched QUERIES.md template does not claim the publisher left queries', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');

  const out = apply(dir, bundle, ['--dry-run']);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  assert.ok(!/left \d+ quer/i.test(out.stdout), `the untouched template must not fire: ${out.stdout}`);
});

t('a QUERIES.md the publisher filled in is reported with its count', () => {
  const dir = makeRepo();
  assert.strictEqual(pkg(dir, 'r1').status, 0);
  const bundle = bundleDirFor(dir, 'r1');
  fs.appendFileSync(path.join(bundle, 'QUERIES.md'),
    '- ch3.md: "the constellation" — capitalised elsewhere?\n- appA.md: two rows labelled (b)\n', 'utf8');

  const out = apply(dir, bundle, ['--dry-run']);
  assert.strictEqual(out.status, 0, out.stderr + out.stdout);
  assert.ok(/left 2 queries/i.test(out.stdout), `expected the real count, got: ${out.stdout}`);
});

console.log('\n=== source inventory ===');

t('accepts a content root whose files match EXPECTED_FILES', () => {
  const dir = makeRepo();
  assert.doesNotThrow(() => P.assertSourceInventory(dir));
});

t('refuses to package when the config and EXPECTED_FILES disagree', () => {
  const dir = makeRepo();
  fs.rmSync(path.join(dir, 'ch9.md'));
  assert.throws(() => P.assertSourceInventory(dir), /disagree about which files/);
});

for (const dir of e2eDirs) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${n - f}/${n} passed`);
process.exit(f === 0 ? 0 : 1);
