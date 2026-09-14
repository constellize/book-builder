#!/usr/bin/env node
'use strict';

/**
 * Apply a publisher's returned markdown back onto the source of truth.
 *
 * The merge is git's, not ours: their edits are committed on a branch rooted at the
 * round's tag, then merged into the current branch with --no-ff. That is what lets
 * the author keep working while the publisher has the files, and what turns an
 * overlap into a visible conflict instead of a silent overwrite.
 */

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const chalk = require('chalk');
const { execFileSync } = require('child_process');
const { program } = require('commander');

// B.resolveLabel, not a second copy of its rules and not an import of the packaging
// CLI: --round 1 must mean the same round-1 here that it meant when the package CLI
// created publisher/round-1, but apply has no use for book.config.js or glob and must
// not fail at require time because one of them is broken.
const B = require('./lib/publisher-bundle.js');
const G = require('./lib/publisher-guard.js');

const EXIT = { OK: 0, BLOCKED: 1, CONFLICTS: 2 };

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function gitAllowFail(cwd, args) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8' }) };
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || '') };
  }
}

/** Locate the directory holding MANIFEST.TXT, whether the bundle nests or not. */
function findBundleRoot(dir) {
  if (fs.existsSync(path.join(dir, 'MANIFEST.TXT'))) return dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(dir, entry.name);
    if (fs.existsSync(path.join(nested, 'MANIFEST.TXT'))) return nested;
  }
  return dir;
}

function loadReferenceKeys(contentDir) {
  const refPath = path.join(contentDir, 'references.json');
  if (!fs.existsSync(refPath)) return null;
  try {
    return new Set(JSON.parse(fs.readFileSync(refPath, 'utf8')).map((r) => r.id));
  } catch (err) {
    console.log(chalk.yellow(`  references.json could not be parsed (${err.message}); skipping citation resolution`));
    return null;
  }
}

const OWN_WORKSPACE_RE = /^.. publisher\//;

/**
 * Exclude this tool's own scratch workspace from a `git status --porcelain` dirty
 * check. Both this script and package-for-publisher.js write into
 * <contentDir>/publisher/, which is untracked and not (yet) gitignored -- without this,
 * the normal package -> send -> apply sequence dirty-blocks itself on its own output. A
 * later task adds publisher/ to the book repo's .gitignore; this filter is
 * belt-and-braces, not the only defence, so everything else in the repo still counts.
 */
function filterOwnWorkspace(porcelain) {
  return porcelain
    .split('\n')
    .filter((line) => line && !OWN_WORKSPACE_RE.test(line))
    .join('\n');
}

/**
 * Design spec line 218: `--dry-run` performs steps 1-4 *plus the diff*. Without it the
 * first command of every round answers "is anything structurally broken?" but not the
 * question the author actually has -- what did the publisher change, and how much?
 *
 * Both sides are written under the scratch directory and diffed with `--no-index`, so
 * this never touches the book repo, never runs `git diff` against its index, and leaves
 * nothing behind when the scratch dir is removed on exit.
 */
function printDryRunDiffStat(contentDir, scratch, tag, snapshot, normalized) {
  const snapDir = path.join(scratch, 'snapshot');
  const retDir = path.join(scratch, 'returned');
  fs.ensureDirSync(snapDir);
  fs.ensureDirSync(retDir);

  const rows = [];
  let changed = 0;
  for (const name of B.EXPECTED_FILES) {
    if (normalized[name] === undefined) continue; // absent from the bundle; file-set has it
    const a = path.join(snapDir, name);
    const b = path.join(retDir, name);
    fs.writeFileSync(a, snapshot[name], 'utf8');
    fs.writeFileSync(b, normalized[name], 'utf8');

    // --no-index exits 1 when the files differ, which is not a failure here.
    const res = gitAllowFail(contentDir, ['diff', '--no-index', '--numstat', '--', a, b]);
    const m = res.out.match(/^(\d+)\t(\d+)\t/m);
    if (!m) continue; // identical
    changed++;
    rows.push({ name, added: Number(m[1]), removed: Number(m[2]) });
  }

  console.log(chalk.blue(`\nReturned files vs ${tag}:`));
  if (!rows.length) {
    console.log(chalk.gray('  no file differs from the snapshot'));
    return;
  }
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const row of rows) {
    console.log(chalk.gray(`  ${row.name.padEnd(width)}  +${row.added}  -${row.removed}`));
  }
  const unchanged = Object.keys(normalized).length - changed;
  console.log(chalk.gray(`  ${changed} file(s) changed, ${unchanged} unchanged`));
}

function main() {
  program
    .name('apply-publisher-edits')
    .argument('<bundle>', 'returned zip or unpacked directory, as the publisher sent it')
    .option('--content-dir <dir>', 'book content root', '.')
    .option('--round <label>', 'round label, when MANIFEST.TXT is missing or unreadable')
    .option('--author <author>', 'git author for the publisher commit', 'Publisher <publisher@localhost>')
    .option('--dry-run', 'normalize and run the guard, then stop without touching git')
    .option('--force', 'merge even when the guard reports errors')
    .option('--no-dewrap', 'do not restore line breaks for re-wrapped paragraphs')
    .parse();

  const opts = program.opts();
  const dryRun = !!opts.dryRun;
  const contentDir = path.resolve(opts.contentDir);
  const bundleArg = path.resolve(program.args[0]);

  B.assertArchiveTools();
  if (!fs.existsSync(bundleArg)) throw new Error(`No such bundle: ${bundleArg}`);

  try {
    git(contentDir, ['rev-parse', '--is-inside-work-tree']);
  } catch (err) {
    throw new Error(`${contentDir} is not inside a git repository`);
  }

  // Captured here, before any git mutation, and reused everywhere below. A detached
  // HEAD must be rejected before we ever branch or commit: `git checkout -q HEAD` is a
  // no-op that leaves the process on the edit branch, and a subsequent "already up to
  // date" merge would report success while merging nothing.
  const originalBranch = git(contentDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (originalBranch === 'HEAD') {
    throw new Error('HEAD is detached. Check out the branch you want the publisher edits merged into, then re-run.');
  }

  // Branch switching needs a clean tree. Submodule pointer changes are excluded:
  // book-builder is a submodule and is routinely modified alongside this work.
  const dirty = filterOwnWorkspace(git(contentDir, ['status', '--porcelain', '--ignore-submodules=all']));
  if (dirty && !dryRun) {
    throw new Error('Working tree has uncommitted changes:\n' + dirty + '\n\nCommit or stash them first.');
  }

  // Unpack into a scratch dir so the publisher's original download is never modified.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-apply-'));
  try {
    let unpacked;
    if (fs.statSync(bundleArg).isDirectory()) {
      unpacked = path.join(scratch, 'bundle');
      fs.copySync(bundleArg, unpacked);
    } else {
      unpacked = path.join(scratch, 'bundle');
      fs.ensureDirSync(unpacked);
      B.unzipTo(bundleArg, unpacked);
    }
    const bundleRoot = findBundleRoot(unpacked);

    let manifest = null;
    const manifestPath = path.join(bundleRoot, 'MANIFEST.TXT');
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = B.parseManifest(fs.readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        console.log(chalk.yellow(`  MANIFEST.TXT is malformed: ${err.message}`));
      }
    }

    // --round is the documented escape hatch for a missing MANIFEST.TXT, i.e. exactly
    // when the operator is already in trouble. It must accept the same spellings the
    // package CLI accepts: `--round 1` created publisher/round-1, so it has to resolve
    // to round-1 here too, not to the tag publisher/1 that has never existed.
    const label = manifest ? manifest.label : (opts.round ? B.resolveLabel(opts.round, []) : null);
    if (!label) {
      throw new Error('MANIFEST.TXT is missing or malformed. Re-run with --round <label> to name the round explicitly.');
    }
    const tag = `publisher/${label}`;

    try {
      git(contentDir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
    } catch (err) {
      throw new Error(`Tag ${tag} does not exist in this repository. It is the merge anchor for this round and cannot be reconstructed.`);
    }
    if (manifest) {
      const tagged = git(contentDir, ['rev-parse', `${tag}^{commit}`]);
      if (tagged !== manifest.commit) {
        throw new Error(`Tag ${tag} points at ${tagged} but MANIFEST.TXT records ${manifest.commit}. The tag has moved; refusing to merge against the wrong snapshot.`);
      }
    }

    // A dry run promises to touch nothing in the book repo: it must not delete a
    // previous round's real reports, nor write its own preview output where a real
    // apply's artifacts live. Preview output goes under the scratch dir instead (and is
    // discarded with it on exit).
    const workspace = path.join(contentDir, 'publisher', label, 'incoming');
    const outDir = dryRun ? path.join(scratch, 'preview') : workspace;
    fs.ensureDirSync(outDir);

    // editBranch survives a successful merge by design (see the branch-exists guard
    // below), so *every* re-run of an already-applied round reaches at least that
    // guard -- this is the ordinary shape of a re-run, not an exotic case. A wholesale
    // `removeSync(workspace)` here would destroy change-report.md, the full-diff audit
    // record of a merge that already landed, before that guard ever gets a chance to
    // fire. So: overwrite in place, and only pre-clear the specific things that would
    // otherwise go stale -- the normalized chapter copies (so a file the current bundle
    // no longer contains doesn't linger from a previous run) and the guard report
    // (which must always describe THIS run). change-report.md, and the copied
    // QUERIES.md/README.md, are left alone; the copy step below refreshes the latter two
    // whenever the current bundle provides them, and change-report.md is exactly the
    // record this fix protects.
    if (!dryRun) {
      for (const name of B.EXPECTED_FILES) fs.removeSync(path.join(outDir, name));
      fs.removeSync(path.join(outDir, 'guard-report.md'));
    }

    // --- Normalize -----------------------------------------------------------
    console.log(chalk.blue(`Applying ${label} (anchor ${tag})`));

    const snapshot = {};
    for (const name of B.EXPECTED_FILES) {
      snapshot[name] = execFileSync('git', ['show', `${tag}:${name}`], { cwd: contentDir, encoding: 'utf8' });
    }

    // Prove the manifest describes THIS tag's content. The hashes were taken from the
    // same `git show` output at pack time, so a mismatch means the manifest and the tag
    // disagree about what was sent — merging against that snapshot would be merging
    // against the wrong base. Returned files are expected to differ and are not checked
    // here; this compares the manifest to the snapshot only.
    if (manifest) {
      const problems = B.verifyManifest(manifest, snapshot);
      if (problems.length) {
        throw new Error(
          'MANIFEST.TXT does not describe the content at ' + tag + ':\n  ' +
          problems.join('\n  ') +
          '\n\nRefusing to merge against a snapshot the manifest does not match.'
        );
      }
    }

    const present = fs.readdirSync(bundleRoot).filter((f) => f.endsWith('.md') || f === 'MANIFEST.TXT');
    const findings = G.checkFileSet(B.EXPECTED_FILES, present.filter((f) => f !== 'MANIFEST.TXT'));

    const refKeys = loadReferenceKeys(contentDir);
    const normalized = {};

    for (const name of B.EXPECTED_FILES) {
      const source = path.join(bundleRoot, name);
      if (!fs.existsSync(source)) continue; // already reported by checkFileSet
      const { text, notes } = B.readAndNormalize(source);
      let finalText = text;
      if (!notes.invalidUtf8 && opts.dewrap !== false) {
        const out = B.dewrapParagraphs(snapshot[name], text);
        finalText = out.text;
        if (out.dewrapped) {
          console.log(chalk.gray(`  ${name}: restored line breaks on ${out.dewrapped} re-wrapped paragraph(s)`));
          // De-wrap is the one place this tool rewrites the publisher's bytes on its
          // own initiative, so it is the one action that most needs an audit trail. A
          // console line scrolls away; guard-report.md is what the author still has in
          // six months. (Design spec line 260 lists dewrap-applied as a warning rule.)
          findings.push(G.makeFinding(name, 'dewrap-applied',
            `restored the snapshot's line breaks on ${out.dewrapped} re-wrapped paragraph(s)`,
            'Only paragraphs whose whitespace-collapsed text was byte-identical to the snapshot were\n' +
            'rewritten, so no edited wording was touched. Re-run with --no-dewrap to keep the\n' +
            "publisher's line breaks."));
        }
      }
      normalized[name] = finalText;
      fs.writeFileSync(path.join(outDir, name), finalText, 'utf8');
      findings.push(...G.compareFiles({
        name, snapshotText: snapshot[name], returnedText: finalText, notes, refKeys,
      }));
    }

    for (const meta of ['QUERIES.md', 'README.md']) {
      const source = path.join(bundleRoot, meta);
      if (fs.existsSync(source)) fs.copySync(source, path.join(outDir, meta));
    }

    const reportPath = path.join(outDir, 'guard-report.md');
    fs.writeFileSync(reportPath, G.renderReport(findings), 'utf8');

    const errors = findings.filter((x) => x.severity === 'error');
    const warnings = findings.filter((x) => x.severity === 'warning');
    // On a dry run, reportPath points into the scratch dir, which the top-level finally
    // deletes before the process exits -- printing that path would be a dead link. The
    // full report is echoed to stdout below instead, so say that explicitly rather than
    // pointing at a file that won't be there to open.
    console.log(chalk.gray(dryRun
      ? `  guard: ${errors.length} error(s), ${warnings.length} warning(s) (preview only -- shown below, not saved)`
      : `  guard: ${errors.length} error(s), ${warnings.length} warning(s) -> ${reportPath}`));

    // Line count was the wrong test: the template this tool ships is itself six lines
    // after trimming, so an untouched QUERIES.md fired the warning on every single
    // round. countQueries ignores everything the template contains and counts only what
    // the publisher added.
    const queriesPath = path.join(outDir, 'QUERIES.md');
    if (fs.existsSync(queriesPath)) {
      const queries = B.countQueries(fs.readFileSync(queriesPath, 'utf8'));
      if (queries > 0) {
        console.log(chalk.yellow(dryRun
          ? `  The publisher left ${queries} quer${queries === 1 ? 'y' : 'ies'} (preview only; re-run without --dry-run to save a copy).`
          : `  The publisher left ${queries} quer${queries === 1 ? 'y' : 'ies'}: ${queriesPath}`));
      }
    }

    if (dryRun) {
      console.log(chalk.blue('\nDry run: git was not touched.'));
      printDryRunDiffStat(contentDir, scratch, tag, snapshot, normalized);
      console.log(G.renderReport(findings));
      return errors.length ? EXIT.BLOCKED : EXIT.OK;
    }

    if (errors.length && !opts.force) {
      console.error(chalk.red(`\nBlocked: ${errors.length} structural error(s). Nothing has been merged.`));
      console.error(chalk.gray(`Read ${reportPath}, then either fix the returned files or re-run with --force.`));
      return EXIT.BLOCKED;
    }

    // --- Merge ---------------------------------------------------------------
    const editBranch = `${tag}-edits`;

    // A previous apply for this round may have left the branch behind. Reusing it would
    // root the publisher's commit on the last attempt instead of on the tag, which is a
    // different and wrong merge base.
    const branchExists = gitAllowFail(contentDir, ['rev-parse', '-q', '--verify', `refs/heads/${editBranch}`]).ok;
    if (branchExists) {
      throw new Error(
        `Branch ${editBranch} already exists from an earlier apply of this round.\n` +
        `Delete it with:  git branch -D ${editBranch}\n` +
        'Check first that nothing on it is unmerged.'
      );
    }

    git(contentDir, ['checkout', '-q', '-b', editBranch, tag]);
    try {
      for (const [name, text] of Object.entries(normalized)) {
        fs.writeFileSync(path.join(contentDir, name), text, 'utf8');
      }
      git(contentDir, ['add', '--'].concat(Object.keys(normalized)));

      const staged = git(contentDir, ['diff', '--cached', '--name-only']);
      if (!staged) {
        console.log(chalk.yellow('The returned files are identical to the snapshot. Nothing to merge.'));
        git(contentDir, ['checkout', '-q', originalBranch]);
        git(contentDir, ['branch', '-q', '-D', editBranch]);
        return EXIT.OK;
      }

      const message = `Publisher edits: ${label}` + (opts.force && errors.length
        ? `\n\nApplied with --force over ${errors.length} guard error(s); see publisher/${label}/incoming/guard-report.md`
        : '');
      git(contentDir, ['commit', '-q', '--author', opts.author, '-m', message]);
    } catch (err) {
      // A failure here leaves nothing of value on editBranch: whatever partial writes or
      // staging happened, no commit landed. The branch must not survive to trip the
      // branch-exists guard on a retry -- that would make the user clean up wreckage from
      // a failure that produced nothing, the same trap Task 7's tag rollback fixed for
      // package-for-publisher.js. Same pattern here: append cleanup failures to the
      // original error rather than replacing it, so the real cause is still reported.
      git(contentDir, ['checkout', '-q', '--force', originalBranch]);
      try {
        git(contentDir, ['branch', '-q', '-D', editBranch]);
      } catch (cleanupErr) {
        err.message += `\n\nAdditionally, failed to remove branch ${editBranch} during cleanup: ${cleanupErr.message}` +
          `\nRemove it manually before retrying: git branch -D ${editBranch}`;
      }
      throw err;
    }

    // The commit above is real and must not be lost. Unlike the write/commit failure
    // above, there is nothing to roll back to here -- editBranch already carries a
    // genuine commit -- so on failure this reports exactly where things stand and how
    // to finish by hand, rather than letting the top-level handler print a bare
    // "Apply failed" while the repo silently sits on editBranch.
    try {
      git(contentDir, ['checkout', '-q', originalBranch]);
    } catch (err) {
      throw new Error(
        `Publisher edits committed to ${editBranch}, but checking out ${originalBranch} to merge them failed: ${err.message}\n\n` +
        `Nothing was lost: the repository is currently on ${editBranch} with that commit intact. Resolve the checkout ` +
        'problem, then finish by hand:\n' +
        `  git checkout ${originalBranch}\n` +
        `  git merge --no-ff ${editBranch}`
      );
    }

    const merge = gitAllowFail(contentDir, ['merge', '--no-ff', '-m', `Merge publisher edits: ${label}`, editBranch]);

    // The merge outcome is decided above; nothing past this point may change it. A
    // change-report is a diagnostic convenience, not a precondition -- if writing it
    // fails (a huge diff past maxBuffer, a full disk), warn and keep reporting what
    // actually happened to the merge.
    const changeReportPath = path.join(workspace, 'change-report.md');
    let changeReportOk = true;
    try {
      const diff = execFileSync('git', ['diff', `${tag}...${editBranch}`], { cwd: contentDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const stat = git(contentDir, ['diff', '--stat', `${tag}...${editBranch}`]);
      fs.writeFileSync(changeReportPath,
        `# Publisher changes — ${label}\n\n\`\`\`\n${stat}\n\`\`\`\n\n## Full diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n`, 'utf8');
    } catch (err) {
      changeReportOk = false;
      console.log(chalk.yellow(`  Could not write ${changeReportPath}: ${err.message}`));
    }

    if (!merge.ok) {
      // gitAllowFail's non-zero exit covers two very different situations. Only one of
      // them is an actual merge-with-conflicts; telling them apart matters because the
      // recovery instructions (and the exit code) are different for each.
      const mergeInProgress = gitAllowFail(contentDir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok;
      if (!mergeInProgress) {
        // git refused to even start the merge -- e.g. an untracked file in the way of
        // one of the incoming paths. No merge is in progress, so nothing was merged:
        // exit 1 is the true outcome, and git's own diagnostic is what explains why.
        throw new Error(`git merge did not start:\n\n${merge.out}`);
      }

      // A failure to list conflicted files must not change the fact that a real merge
      // conflict exists and exit 2 is the correct, already-decided outcome.
      let conflicted = '(could not list conflicted files -- run `git status` by hand)';
      try {
        conflicted = git(contentDir, ['diff', '--name-only', '--diff-filter=U']);
      } catch (err) {
        console.log(chalk.yellow(`  Could not list conflicted files: ${err.message}`));
      }
      console.log(chalk.yellow('\nMerge stopped on conflicts. This is expected when both sides edited the same paragraph.'));
      console.log(chalk.yellow('Conflicted files:\n' + conflicted));
      console.log(chalk.gray('\nResolve them, then:  git add <files> && git commit'));
      console.log(chalk.gray(`To abandon the merge:  git merge --abort`));
      return EXIT.CONFLICTS;
    }

    console.log(chalk.green(`\nMerged cleanly into ${originalBranch}.`));
    if (changeReportOk) console.log(chalk.gray(`  changes:  ${changeReportPath}`));
    console.log(chalk.gray(`  guard:    ${reportPath}`));
    console.log(chalk.gray('\nNext:  make book-validate  ->  npm run build:docx  ->  visual pass on the render'));
    console.log(chalk.gray(`To undo this merge:  git reset --hard ORIG_HEAD`));
    return EXIT.OK;
  } finally {
    // The normalized copies and both reports already live under workspace (a durable,
    // inspectable path); this is purely the throwaway unpack directory. A failed cleanup
    // here is a leftover temp dir, never a reason to change the exit code.
    try {
      fs.removeSync(scratch);
    } catch (err) {
      console.log(chalk.yellow(`  Could not remove scratch directory ${scratch}: ${err.message}`));
    }
  }
}

if (require.main === module) {
  // process.exitCode, not process.exit(): process.exit() tears the process down without
  // waiting for a piped stdout to drain, and on the --dry-run path stdout -- the guard
  // report and the diff stat -- is the entire output of the run.
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(chalk.red(`Apply failed: ${err.message}`));
    process.exitCode = EXIT.BLOCKED;
  }
}

module.exports = { EXIT, findBundleRoot };
