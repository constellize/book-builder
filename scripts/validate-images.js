#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Regex to match image references in markdown
// Matches both standard markdown: ![alt](path)
// And pandoc-crossref style: ![caption](path){#fig:label}
const imageRefRegex = /!\[[^\]]*\]\(([^)]+)\)(?:\{[^}]*\})?/g;

// File patterns for book content
const bookContentPatterns = [
  /^ch\d+.*\.md$/,           // Chapter files (ch1.md, ch2.md, etc.)
  /^introduction\.md$/,      // Introduction
  /^app[A-Z].*\.md$/,        // Appendix files (appA.md, appB.md, etc.)
  /^foreword.*\.md$/,        // Foreword files
];

// Patterns to exclude
const excludePatterns = [
  /^codepromptu\//,
  /^narrative-/,
  /^memory-bank\//,
  /^marketing\//,
  /^tools\//,
  /^build\//,
  /^\.git/,
  /^node_modules\//,
  /^book-builder\//,
  /^book-backup\//,
];

function shouldProcessFile(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);

  // Exclude dependency and backup directories
  if (relativePath.includes('node_modules') ||
      relativePath.includes('book-builder/') ||
      relativePath.includes('book-backup/') ||
      relativePath.includes('.git/')) {
    return false;
  }

  // Exclude development files
  for (const pattern of excludePatterns) {
    if (pattern.test(relativePath)) {
      return false;
    }
  }

  // Only include book content files
  const fileName = path.basename(relativePath);
  for (const pattern of bookContentPatterns) {
    if (pattern.test(fileName)) {
      return true;
    }
  }

  return false;
}

function findImageReferences(content) {
  const refs = [];
  let match;

  // Reset regex state
  imageRefRegex.lastIndex = 0;

  while ((match = imageRefRegex.exec(content)) !== null) {
    const imagePath = match[1];
    // Only track local image references (not URLs)
    if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
      refs.push({
        path: imagePath,
        index: match.index
      });
    }
  }

  return refs;
}

function getLineNumber(text, index) {
  return text.substring(0, index).split('\n').length;
}

function validateImages() {
  console.log('Validating image references in book content files...\n');

  // Find all markdown files
  const markdownFiles = glob.sync('**/*.md', {
    ignore: [
      '**/node_modules/**',
      '**/book-builder/**',
      '**/book-backup/**',
      '**/build/**',
      '**/.git/**',
    ]
  });

  // Filter to book content files
  const bookFiles = markdownFiles.filter(shouldProcessFile);

  console.log(`Found ${bookFiles.length} book content files to validate.\n`);

  // Collect all image references
  const allImageRefs = new Map(); // path -> [{ file, line }]

  for (const filePath of bookFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const refs = findImageReferences(content);

      for (const { path: imagePath, index } of refs) {
        const line = getLineNumber(content, index);
        if (!allImageRefs.has(imagePath)) {
          allImageRefs.set(imagePath, []);
        }
        allImageRefs.get(imagePath).push({ file: filePath, line });
      }
    } catch (error) {
      console.error(`Error reading ${filePath}: ${error.message}`);
    }
  }

  // Find all PNG files in images/diagrams
  const imageFiles = glob.sync('images/diagrams/**/*.png');
  const imageFileSet = new Set(imageFiles);

  let hasErrors = false;
  const missingImages = [];
  const orphanedImages = [];

  // Check 1: All referenced images exist
  console.log('--- Checking referenced images exist ---\n');

  for (const [imagePath, refs] of allImageRefs) {
    if (!fs.existsSync(imagePath)) {
      hasErrors = true;
      missingImages.push({ path: imagePath, refs });
      for (const { file, line } of refs) {
        console.log(`MISSING: ${imagePath}`);
        console.log(`  Referenced in ${file}:${line}\n`);
      }
    }
  }

  if (missingImages.length === 0) {
    console.log(`All ${allImageRefs.size} referenced images exist.\n`);
  }

  // Check 2: All image files are referenced
  console.log('--- Checking for orphaned images ---\n');

  const referencedPaths = new Set(allImageRefs.keys());

  for (const imageFile of imageFiles) {
    if (!referencedPaths.has(imageFile)) {
      hasErrors = true;
      orphanedImages.push(imageFile);
      console.log(`ORPHANED: ${imageFile}`);
      console.log(`  Not referenced in any book content file\n`);
    }
  }

  if (orphanedImages.length === 0) {
    console.log(`All ${imageFiles.length} image files are referenced.\n`);
  }

  // Summary
  console.log('\n--- Validation Summary ---\n');
  console.log(`Book files checked: ${bookFiles.length}`);
  console.log(`Image references found: ${allImageRefs.size}`);
  console.log(`Image files on disk: ${imageFiles.length}`);
  console.log(`Missing images: ${missingImages.length}`);
  console.log(`Orphaned images: ${orphanedImages.length}`);

  if (hasErrors) {
    console.log('\nIMAGE VALIDATION FAILED\n');

    if (missingImages.length > 0) {
      console.log('Missing images (referenced but not found):');
      for (const { path: imagePath } of missingImages) {
        console.log(`  - ${imagePath}`);
      }
    }

    if (orphanedImages.length > 0) {
      console.log('\nOrphaned images (exist but not referenced):');
      for (const imagePath of orphanedImages) {
        console.log(`  - ${imagePath}`);
      }
      console.log('\nTo remove orphaned images:');
      for (const imagePath of orphanedImages) {
        console.log(`  rm "${imagePath}"`);
      }
    }

    process.exit(1);
  } else {
    console.log('\nIMAGE VALIDATION PASSED');
    console.log('All image references are valid and all images are referenced.');
  }
}

// Run validation if called directly
if (require.main === module) {
  validateImages();
}

module.exports = { validateImages };
