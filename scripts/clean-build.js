#!/usr/bin/env node

/**
 * Clean Build Script
 * Removes build artifacts and temporary files
 */

const fs = require('fs-extra');
const path = require('path');
const glob = require('glob');
const chalk = require('chalk');

const config = require('../config/book.config.js');

// DESTRUCTIVE: build/ holds the shipped PDFs, EPUB and HTML. Pass --dry-run to
// list what would be removed without removing anything.
const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n');

async function clean() {
  console.log(chalk.blue(DRY_RUN ? 'Clean (DRY RUN - nothing will be deleted)...' : 'Cleaning build artifacts...'));

  const rootDir = config.source.root;
  const buildDir = path.resolve(rootDir, 'build');

  try {
    // Remove ONLY build-owned artefacts - never the build/ tree itself.
    //
    // This used to be `fs.remove(buildDir)`. build/ also holds files no target
    // regenerates: build/print/constellize-book-print-preview-2026.01.pdf is a
    // hand-made 2026-01-03 artefact, and `make book-build` calls this script
    // before building, so a blunt wipe destroyed it silently and unrecoverably.
    // BookBuilder.cleanBuild() already scopes itself this way; this script is the
    // path that did not.
    //
    // Owned = the output file each configured target produces, plus intermediate/
    // and assets/, which are pure scratch refreshed on every build.
    if (await fs.pathExists(buildDir)) {
      const owned = new Set();
      for (const [name, out] of Object.entries(config.outputs || {})) {
        const dir = path.resolve(rootDir, out.directory);
        const ext = { pdf: '.pdf', html5: '.html', epub3: '.epub', docx: '.docx' }[out.format] || '.html';
        owned.add(path.join(dir, `constellize-book${ext}`));
      }
      owned.add(path.join(buildDir, 'intermediate'));
      owned.add(path.join(buildDir, 'assets'));

      for (const target of owned) {
        if (!(await fs.pathExists(target))) continue;
        if (DRY_RUN) {
          console.log(chalk.yellow(`would remove: ${target}`));
        } else {
          await fs.remove(target);
          console.log(chalk.green(`Removed ${path.relative(rootDir, target)}`));
        }
      }

      // Anything else under build/ is not ours. Say so rather than deleting it.
      // Exclude the owned set itself, and anything nested inside an owned
      // directory (intermediate/, assets/) - those are going away with it.
      const isOwned = (f) =>
        [...owned].some((o) => f === o || f.startsWith(o + path.sep));
      const survivors = glob
        .sync('**/*', { cwd: buildDir, absolute: true, nodir: true })
        .filter((f) => !path.basename(f).startsWith('.'))
        .filter((f) => !isOwned(f));
      if (survivors.length > 0) {
        console.log(chalk.gray(`Left untouched (not build-owned): ${survivors
          .map((f) => path.relative(buildDir, f))
          .join(', ')}`));
      }
    } else {
      console.log(chalk.gray('Build directory does not exist'));
    }

    // Remove any temporary files.
    // NOTE: '*.tmp' used to be passed to path.resolve() and then fs.pathExists(),
    // which tests for a file literally named "*.tmp". It never matched anything,
    // so no .tmp file was ever cleaned. Glob patterns must be expanded.
    const tempPatterns = ['temp-input.md', '*.tmp'];
    const tempFiles = tempPatterns.flatMap((pattern) =>
      glob.sync(pattern, { cwd: rootDir, absolute: true })
    );

    if (tempFiles.length === 0) {
      console.log(chalk.gray('No temporary files to remove'));
    }

    for (const tempFile of tempFiles) {
      if (DRY_RUN) {
        console.log(chalk.yellow(`would remove file: ${tempFile}`));
      } else {
        await fs.remove(tempFile);
        console.log(chalk.green(`Removed ${path.basename(tempFile)}`));
      }
    }

    console.log(chalk.green(DRY_RUN ? 'Dry run complete - nothing was deleted.' : 'Clean completed successfully!'));

  } catch (error) {
    console.error(chalk.red('Clean failed:', error.message));
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  clean();
}

module.exports = clean;
