#!/usr/bin/env node

/**
 * Link Validation Script
 * Validates repository links and external URLs in markdown files
 */

const fs = require('fs-extra');
const path = require('path');
const glob = require('glob');
const chalk = require('chalk');

const config = require('../config/book.config.js');

/**
 * True if `pattern` contains any glob metacharacter and must be expanded by glob
 * rather than treated as a literal filename. Covers '*', '?', character classes
 * '[...]' and brace expansion '{...}'.
 */
function isGlobPattern(pattern) {
  return /[*?]/.test(pattern) || /\[.*\]/.test(pattern) || /\{.*\}/.test(pattern);
}

class LinkValidator {
  constructor() {
    this.rootDir = config.source.root;
    this.errors = [];
    this.warnings = [];
  }

  async validate() {
    console.log(chalk.blue('🔗 Validating links in book files...'));
    
    // Find all markdown files.
    // NOTE: config.source.introduction was missing here, so introduction.md was
    // never link-checked.
    const patterns = [
      config.source.foreword,
      config.source.introduction,
      ...config.source.chapters,
      ...config.source.appendices
    ].filter(Boolean);

    const allFiles = [];
    for (const pattern of patterns) {
      // NOTE: this used to test only for '*'. The real patterns are 'ch[1-9].md'
      // and 'app[AB].md', which contain no '*', so they fell through to the
      // literal-path branch, fs.pathExists('/.../ch[1-9].md') returned false, and
      // all 9 chapters plus both appendices were silently skipped -- the gate was
      // only ever checking foreword-faq.md. Detect every glob metacharacter.
      if (isGlobPattern(pattern)) {
        const files = glob.sync(path.resolve(this.rootDir, pattern));
        allFiles.push(...files.sort());
      } else {
        const file = path.resolve(this.rootDir, pattern);
        if (await fs.pathExists(file)) {
          allFiles.push(file);
        }
      }
    }

    console.log(chalk.gray(`Found ${allFiles.length} files to validate`));
    
    for (const file of allFiles) {
      await this.validateFile(file);
    }
    
    this.printResults();
  }

  async validateFile(filePath) {
    const fileName = path.basename(filePath);
    console.log(chalk.gray(`Validating: ${fileName}`));
    
    const content = await fs.readFile(filePath, 'utf8');
    
    // Find all markdown links
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    
    while ((match = linkRegex.exec(content)) !== null) {
      const [fullMatch, linkText, linkUrl] = match;
      await this.validateLink(fileName, linkText, linkUrl);
    }
  }

  async validateLink(fileName, linkText, linkUrl) {
    // Skip anchors and mailto links
    if (linkUrl.startsWith('#') || linkUrl.startsWith('mailto:')) {
      return;
    }

    // Skip {SITE_BASE} links - these refer to the external companion website
    if (linkUrl.includes('{SITE_BASE}')) {
      return;
    }
    
    // Check {BOOK_REPO_BASE} placeholders (book-related content)
    if (linkUrl.includes('{BOOK_REPO_BASE}')) {
      const repoPath = linkUrl.replace('{BOOK_REPO_BASE}', '');
      const fullPath = path.resolve(this.rootDir, repoPath);
      
      if (!await fs.pathExists(fullPath)) {
        this.errors.push({
          file: fileName,
          link: linkText,
          url: linkUrl,
          issue: 'Book repository file not found',
          path: fullPath
        });
      }
      return;
    }
    
    // Check {CODEPROMPTU_REPO_BASE} placeholders (CodePromptu code examples)
    if (linkUrl.includes('{CODEPROMPTU_REPO_BASE}')) {
      const repoPath = linkUrl.replace('{CODEPROMPTU_REPO_BASE}', '');
      const fullPath = path.resolve(this.rootDir, 'codepromptu', repoPath);
      
      if (!await fs.pathExists(fullPath)) {
        this.errors.push({
          file: fileName,
          link: linkText,
          url: linkUrl,
          issue: 'CodePromptu repository file not found',
          path: fullPath
        });
      }
      return;
    }
    
    // Check local file links
    if (!linkUrl.startsWith('http')) {
      const fullPath = path.resolve(this.rootDir, linkUrl);
      
      if (!await fs.pathExists(fullPath)) {
        this.errors.push({
          file: fileName,
          link: linkText,
          url: linkUrl,
          issue: 'Local file not found',
          path: fullPath
        });
      }
      return;
    }
    
    // External URLs - just warn for now
    this.warnings.push({
      file: fileName,
      link: linkText,
      url: linkUrl,
      issue: 'External URL (not validated)'
    });
  }

  printResults() {
    console.log('\n' + chalk.blue('📊 Validation Results'));
    
    if (this.errors.length === 0 && this.warnings.length === 0) {
      console.log(chalk.green('✅ All links validated successfully!'));
      return;
    }
    
    if (this.errors.length > 0) {
      console.log(chalk.red(`\n❌ Found ${this.errors.length} errors:`));
      for (const error of this.errors) {
        console.log(chalk.red(`  ${error.file}: "${error.link}" -> ${error.url}`));
        console.log(chalk.gray(`    ${error.issue}: ${error.path || error.url}`));
      }
    }
    
    if (this.warnings.length > 0) {
      console.log(chalk.yellow(`\n⚠️  Found ${this.warnings.length} warnings:`));
      for (const warning of this.warnings) {
        console.log(chalk.yellow(`  ${warning.file}: "${warning.link}" -> ${warning.url}`));
        console.log(chalk.gray(`    ${warning.issue}`));
      }
    }
    
    if (this.errors.length > 0) {
      process.exit(1);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const validator = new LinkValidator();
  validator.validate().catch(error => {
    console.error(chalk.red('Validation failed:', error.message));
    process.exit(1);
  });
}

module.exports = LinkValidator;
