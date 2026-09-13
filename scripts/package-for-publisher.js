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
const { execFileSync } = require('child_process');
const { program } = require('commander');

const B = require('./lib/publisher-bundle.js');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

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
  return `# The Constellize Method — markdown for copy-editing

**Round:** ${label}
**Packed:** ${date}
**Edition:** ${edition} (version ${version})

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
| Anything inside \`\`\`\`\`\` fences | shell and code samples | Code is verified against a working repository. |

## Two requests

**Please do not re-wrap or reflow paragraphs.** Line breaks inside a paragraph carry
no meaning in the finished book, but re-wrapping turns a reviewable list of your
edits into a whole-file rewrite, which makes your work much harder to see.

**Please raise questions in \`QUERIES.md\`** rather than as notes inside the chapters.
Anything written into the chapter files is treated as book text.

## Returning your work

Save every file as UTF-8, keep all 13 filenames exactly as they are, add no files and
remove none, then zip this folder back up and send it.
`;
}

function readMetadataField(contentDir, field, fallback) {
  const metadataPath = path.join(contentDir, 'metadata.yaml');
  if (!fs.existsSync(metadataPath)) return fallback;
  const m = fs.readFileSync(metadataPath, 'utf8').match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'));
  return m ? m[1].trim() : fallback;
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
      edition: readMetadataField(contentDir, 'edition', 'unknown'),
      version: readMetadataField(contentDir, 'version', 'unknown'),
    }), 'utf8');
  fs.writeFileSync(path.join(bundleDir, 'QUERIES.md'),
    `# Queries — ${label}\n\nList anything you want the author to answer or decide.\nOne query per bullet, with the file and a quoted phrase so it can be found.\n\n- \n`, 'utf8');

  const zipPath = path.join(outgoingDir, `${bundleName}.zip`);
  fs.removeSync(zipPath);
  B.zipDir(outgoingDir, bundleName, zipPath);

  console.log(chalk.green('\nPackage ready'));
  console.log(chalk.gray(`  zip: ${zipPath}`));
  console.log(chalk.gray(`  tag: ${tag} -> ${commit}`));
  console.log(chalk.gray(`\nThe tag is the merge anchor. Push it so it is not lost:  git push origin ${tag}`));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(chalk.red(`Packaging failed: ${err.message}`));
    process.exit(1);
  }
}

module.exports = { resolveLabel, buildReadme };
