#!/usr/bin/env node
'use strict';

/**
 * Package the book's markdown sources for a publisher.
 *
 * The bundle is read from the tag this script creates, never from the working tree,
 * so "the zip matches the tag" is true by construction rather than by precondition.
 * apply-publisher-edits.js three-way merges against that same tag.
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const glob = require('glob');
const { execFileSync } = require('child_process');
const { program } = require('commander');

const B = require('./lib/publisher-bundle.js');
const bookConfig = require('../config/book.config.js');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * B.EXPECTED_FILES is a second declaration of something book.config.js already states:
 * the build reads `foreword-faq.md`, `introduction.md`, `ch[1-9].md`, `app[AB].md`.
 * They agree today. If they ever diverge -- a tenth chapter, a renamed appendix -- the
 * publisher silently never sees the new file and no guard rule fires, because every
 * rule is scoped to EXPECTED_FILES in the first place. Nothing downstream can catch
 * that, so catch it here, loudly, before a round goes out.
 *
 * Resolution mirrors build-book.js exactly: the same glob patterns against the same
 * content root.
 */
function assertSourceInventory(contentDir) {
  const { source } = bookConfig;
  const resolved = [source.foreword, source.introduction]
    .filter(Boolean)
    .filter((name) => fs.existsSync(path.join(contentDir, name)));

  for (const pattern of [].concat(source.chapters || [], source.appendices || [])) {
    resolved.push(...glob.sync(pattern, { cwd: contentDir }));
  }

  const fromConfig = [...new Set(resolved)].sort();
  const fromBundle = [...B.EXPECTED_FILES].sort();
  if (fromConfig.join('\n') === fromBundle.join('\n')) return;

  const missing = fromBundle.filter((f) => !fromConfig.includes(f));
  const extra = fromConfig.filter((f) => !fromBundle.includes(f));
  throw new Error(
    'The book config and the publisher bundle disagree about which files the build reads.\n' +
    `  book.config.js resolves to: ${fromConfig.join(', ') || '(nothing)'}\n` +
    `  EXPECTED_FILES lists:       ${fromBundle.join(', ')}\n` +
    (extra.length ? `  Not in EXPECTED_FILES: ${extra.join(', ')} — the publisher would never see these.\n` : '') +
    (missing.length ? `  Not found via the config: ${missing.join(', ')}\n` : '') +
    '\nReconcile config/book.config.js and EXPECTED_FILES in scripts/lib/publisher-bundle.js before packaging.'
  );
}

function resolveLabel(requested, existingTags) {
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    const raw = String(requested).trim();
    if (/^\d+$/.test(raw)) return `round-${raw}`;
    const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new Error(`--round "${raw}" contains no usable characters`);
    return slug;
  }
  const used = existingTags
    .map((tag) => tag.match(/^publisher\/round-(\d+)$/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return `round-${used.length ? Math.max(...used) + 1 : 1}`;
}

function buildReadme({ label, date, edition, version }) {
  // A list, not three consecutive lines: markdown joins consecutive lines into one
  // paragraph, so the three fields rendered as a single run-on sentence.
  return `# The Constellize Method — markdown for copy-editing

- **Round:** ${label}
- **Packed:** ${date}
- **Edition:** ${edition} (version ${version})

Thank you for working on this. These are the book's source files, exactly as the
build system reads them. Editing them directly means your changes go straight into
the book — nothing has to be re-keyed.

## Reading order

1. \`foreword-faq.md\`
2. \`introduction.md\`
3. \`ch1.md\` … \`ch9.md\`
4. References — generated from a citation database, not included here
5. \`appA.md\`, \`appB.md\`

## What to edit

All of the prose: body text, heading wording, list wording, the text inside callout
boxes, and the descriptive alt text inside image references.

## What not to edit

These constructs are instructions to the build system. They look like stray
punctuation but each one produces something in the finished book, and changing one
usually fails silently — the book builds, and the affected element is simply missing.

| Leave alone | Example | What it is |
| --- | --- | --- |
| \`:::\` fence lines | \`::: {.promptref title="Constellation Mapping" url="{SITE_BASE}/prompts/v1/constellation-map"}\` | Opens a callout box. The matching \`:::\` closes it. Edit the text between them, never the fence lines. |
| \`{SITE_BASE}\`, \`{CODEPROMPTU_REPO_BASE}\` | \`{SITE_BASE}/prompts\` | Replaced with a real URL at build time. |
| \`{{double braces}}\` | \`{{system_name}}\` | A fill-in-the-blank slot in a prompt example. The reader substitutes their own value. |
| \`{#fig:…}\`, \`{#sec:…}\` | \`![A diagram](images/x.png){#fig:map-first}\` | The label other pages cross-reference. |
| \`[@…]\` | \`[@atkinson2026]\` | A citation. The bibliography is generated from these. |
| Image paths | \`images/diagrams/ch3/thing.png\` | The alt text before it is yours to edit; the path is not. |
| Anything inside \`\`\`\`\` \`\`\` \`\`\`\`\` fences | shell and code samples | Code is verified against a working repository. |

## Two requests

**Please do not re-wrap or reflow paragraphs.** Line breaks inside a paragraph carry
no meaning in the finished book, but re-wrapping turns a reviewable list of your
edits into a whole-file rewrite, which makes your work much harder to see.

**Please raise questions in \`QUERIES.md\`** rather than as notes inside the chapters.
Anything written into the chapter files is treated as book text.

## Returning your work

Save every file as UTF-8, keep all ${B.EXPECTED_FILES.length} filenames exactly as they are, add no files and
remove none, then zip this folder back up and send it.
`;
}

/**
 * Read a metadata.yaml field as it stood at the tag, not the working tree — the
 * same rule that governs the 13 bundle sources. metadata.yaml isn't one of those
 * 13 files and isn't covered by the dirty check, so reading it off disk could put
 * an uncommitted edition string into a publisher-facing README.
 *
 * A missing metadata.yaml (at the tag or anywhere) is not fatal — packaging still
 * proceeds with the fallback — but every fallback path is loud about it, since a
 * silent "unknown" in a document a publisher sees is worse than a warning.
 */
function readMetadataField(contentDir, tag, field, fallback) {
  let text = null;
  try {
    text = execFileSync('git', ['show', `${tag}:metadata.yaml`], { cwd: contentDir, encoding: 'utf8' });
  } catch (err) {
    const metadataPath = path.join(contentDir, 'metadata.yaml');
    if (fs.existsSync(metadataPath)) {
      console.warn(chalk.yellow(
        `metadata.yaml is not committed at ${tag}; README ${field} comes from the working tree instead of the tag.`
      ));
      text = fs.readFileSync(metadataPath, 'utf8');
    }
  }
  if (text === null) {
    console.warn(chalk.yellow(
      `metadata.yaml was not found at ${tag} or in the working tree; README ${field} will read "${fallback}".`
    ));
    return fallback;
  }
  const m = text.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'));
  if (!m) {
    console.warn(chalk.yellow(`metadata.yaml has no "${field}:" field; README ${field} will read "${fallback}".`));
    return fallback;
  }
  return m[1].trim();
}

function main() {
  program
    .name('package-for-publisher')
    .argument('[contentDir]', 'book content root', '.')
    .option('--round <label>', 'round label; a bare integer becomes round-N')
    .parse();

  const opts = program.opts();
  const contentDir = path.resolve(program.args[0] || '.');

  B.assertArchiveTools();
  assertSourceInventory(contentDir);

  try {
    git(contentDir, ['rev-parse', '--is-inside-work-tree']);
  } catch (err) {
    throw new Error(`${contentDir} is not inside a git repository`);
  }

  // Scoped to the 13 sources on purpose. book-builder is a submodule, so a plain
  // `git status --porcelain` reports ` M book-builder` whenever the build tool is
  // being worked on, which has nothing to do with whether the chapters are clean.
  const dirty = git(contentDir, ['status', '--porcelain', '--'].concat(B.EXPECTED_FILES));
  if (dirty) {
    throw new Error(
      'These source files have uncommitted changes:\n' + dirty +
      '\n\nCommit or stash them first. The tag must name a commit that actually contains what is in the zip.'
    );
  }

  const existingTags = git(contentDir, ['tag', '-l', 'publisher/*']).split('\n').filter(Boolean);
  const label = resolveLabel(opts.round, existingTags);
  const tag = `publisher/${label}`;

  if (existingTags.includes(tag)) {
    throw new Error(
      `Tag ${tag} already exists. Use a new --round label.\n` +
      'Moving the anchor of a round that has already been sent would corrupt its merge.'
    );
  }

  git(contentDir, ['tag', tag]);

  // Everything from here on is risky I/O (git show, filesystem writes, zip). If any
  // of it throws, the tag we just created must not survive — a dangling tag makes a
  // retry with the same --round label fail with a "would corrupt its merge" message
  // that is actively misleading, since nothing was ever sent out. Roll the tag back
  // and re-throw the *original* error so the top-level handler reports what actually
  // went wrong, not a cleanup artifact.
  try {
    const commit = git(contentDir, ['rev-parse', tag + '^{commit}']);
    const date = new Date().toISOString().slice(0, 10);
    console.log(chalk.blue(`Packaging ${label} at ${commit.slice(0, 8)}`));

    const bundleName = `constellize-book-${label}`;
    const outgoingDir = path.join(contentDir, 'publisher', label, 'outgoing');
    const bundleDir = path.join(outgoingDir, bundleName);
    fs.removeSync(bundleDir);
    fs.ensureDirSync(bundleDir);

    const files = [];
    for (const name of B.EXPECTED_FILES) {
      const content = execFileSync('git', ['show', `${tag}:${name}`], { cwd: contentDir, encoding: 'utf8' });
      fs.writeFileSync(path.join(bundleDir, name), content, 'utf8');
      files.push({ name, sha256: B.sha256(content) });
      console.log(chalk.gray(`  + ${name}`));
    }

    fs.writeFileSync(path.join(bundleDir, 'MANIFEST.TXT'),
      B.renderManifest({ label, tag, commit, date, files }), 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'README.md'),
      buildReadme({
        label, date,
        edition: readMetadataField(contentDir, tag, 'edition', 'unknown'),
        version: readMetadataField(contentDir, tag, 'version', 'unknown'),
      }), 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'QUERIES.md'), B.renderQueries(label), 'utf8');

    const zipPath = path.join(outgoingDir, `${bundleName}.zip`);
    fs.removeSync(zipPath);
    B.zipDir(outgoingDir, bundleName, zipPath);

    console.log(chalk.green('\nPackage ready'));
    console.log(chalk.gray(`  zip: ${zipPath}`));
    console.log(chalk.gray(`  tag: ${tag} -> ${commit}`));
    console.log(chalk.gray(`\nThe tag is the merge anchor. Push it so it is not lost:  git push origin ${tag}`));
  } catch (err) {
    try {
      git(contentDir, ['tag', '-d', tag]);
    } catch (cleanupErr) {
      err.message += `\n\nAdditionally, failed to remove tag ${tag} during cleanup: ${cleanupErr.message}` +
        `\nRemove it manually before retrying: git tag -d ${tag}`;
    }
    throw err;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(chalk.red(`Packaging failed: ${err.message}`));
    // process.exitCode, not process.exit(): the latter tears the process down before a
    // piped stdout/stderr has necessarily drained, and the error text above is the only
    // thing that explains the failure.
    process.exitCode = 1;
  }
}

module.exports = { resolveLabel, buildReadme, assertSourceInventory };
