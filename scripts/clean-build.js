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
    // Remove build directory
    if (await fs.pathExists(buildDir)) {
      if (DRY_RUN) {
        console.log(chalk.yellow(`would remove directory: ${buildDir}`));
      } else {
        await fs.remove(buildDir);
        console.log(chalk.green('Removed build directory'));
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
