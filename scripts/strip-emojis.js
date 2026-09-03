#!/usr/bin/env node

/**
 * Strip Emojis Script
 * Removes all emoji characters from book content markdown files only
 * Excludes narrative files and other non-book content
 */

const fs = require('fs');
const path = require('path');

// Import approved emojis from validation script to keep them synchronized
const { approvedEmojis } = require('./validate-emojis.js');

// Comprehensive emoji regex pattern covering most Unicode emoji ranges
const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F018}-\u{1F270}]|[\u{238C}]|[\u{2194}-\u{2199}]|[\u{21A9}-\u{21AA}]|[\u{231A}-\u{231B}]|[\u{2328}]|[\u{23CF}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{24C2}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2600}-\u{2604}]|[\u{260E}]|[\u{2611}]|[\u{2614}-\u{2615}]|[\u{2618}]|[\u{261D}]|[\u{2620}]|[\u{2622}-\u{2623}]|[\u{2626}]|[\u{262A}]|[\u{262E}-\u{262F}]|[\u{2638}-\u{263A}]|[\u{2640}]|[\u{2642}]|[\u{2648}-\u{2653}]|[\u{265F}-\u{2660}]|[\u{2663}]|[\u{2665}-\u{2666}]|[\u{2668}]|[\u{267B}]|[\u{267E}-\u{267F}]|[\u{2692}-\u{2697}]|[\u{2699}]|[\u{269B}-\u{269C}]|[\u{26A0}-\u{26A1}]|[\u{26A7}]|[\u{26AA}-\u{26AB}]|[\u{26B0}-\u{26B1}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26C8}]|[\u{26CE}-\u{26CF}]|[\u{26D1}]|[\u{26D3}-\u{26D4}]|[\u{26E9}-\u{26EA}]|[\u{26F0}-\u{26F5}]|[\u{26F7}-\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]/gu;

// Define which files should be processed (book content only)
// NOTE: kept in step with bookContentPatterns in validate-emojis.js. If validate
// can flag a file, strip must be able to reach it, otherwise the remediation
// advice printed by the failing gate is a dead end.
// The emojiRegex above deliberately does NOT cover U+2500-257F (box drawing) or
// U+2192 (->). Those are legitimate typography used in ch5.md's directory trees
// and in prose across introduction.md / ch7-ch9.md, and this script must never
// delete them. Verified: stripEmojis() is a no-op on all of those files.
const bookContentPatterns = [
  /^ch\d+.*\.md$/,        // Chapter files: ch1.md, ch2.md, etc.
  /^introduction\.md$/,   // Introduction
  /^app[A-Z].*\.md$/,     // Appendix files: appA.md, appB.md, etc.
  /^foreword.*\.md$/,     // Foreword files
  /^README\.md$/,         // Main README
  /^tone\.md$/            // Tone guide
];

// Define patterns to exclude (narrative and other files)
const excludePatterns = [
  /^narrative-/,       // All narrative files
  /^codepromptu\//,    // CodePromptu project files
  /^memory-bank\//,    // Memory bank files
  /^marketing\//,      // Marketing files
  /^tools\//,          // Tools directory
  /^build\//,          // Build directory
  /^images\//,         // Images directory
  /test-emoji\.md$/    // Test files
];

/**
 * Check if a file should be processed based on patterns
 */
function shouldProcessFile(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  
  // Exclude files that match exclude patterns
  for (const pattern of excludePatterns) {
    if (pattern.test(relativePath)) {
      return false;
    }
  }
  
  // Only include files that match book content patterns
  const fileName = path.basename(relativePath);
  for (const pattern of bookContentPatterns) {
    if (pattern.test(fileName)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Strip emojis from text content, but preserve approved emojis
 */
function stripEmojis(content) {
  return content.replace(emojiRegex, (match) => {
    // Keep approved emojis, remove all others
    return approvedEmojis.has(match) ? match : '';
  });
}

/**
 * Process a single markdown file
 */
function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const originalLength = content.length;
    const strippedContent = stripEmojis(content);
    const newLength = strippedContent.length;
    
    if (originalLength !== newLength) {
      fs.writeFileSync(filePath, strippedContent, 'utf8');
      console.log(`✅ Processed ${filePath} (removed ${originalLength - newLength} emoji characters)`);
      return true;
    } else {
      console.log(`⚪ No emojis found in ${filePath}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error.message);
    return false;
  }
}

/**
 * Find all markdown files in the current directory
 */
function findMarkdownFiles(dir = '.') {
  const files = [];
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // Only recurse into specific directories to avoid processing everything
        if (['codepromptu', 'memory-bank', 'tools', 'build', 'images', 'marketing'].includes(entry.name)) {
          continue; // Skip these directories entirely
        }
        files.push(...findMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (shouldProcessFile(fullPath)) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error.message);
  }
  
  return files;
}

/**
 * Main function
 */
function main() {
  console.log('🧹 Stripping unapproved emojis from book content files...\n');
  console.log(`📋 Approved emojis (will be preserved): ${Array.from(approvedEmojis).join(' ')}\n`);
  
  const markdownFiles = findMarkdownFiles();
  
  if (markdownFiles.length === 0) {
    console.log('No book content markdown files found to process.');
    return;
  }
  
  console.log(`Found ${markdownFiles.length} book content files to process:\n`);
  
  let processedCount = 0;
  let modifiedCount = 0;
  
  for (const file of markdownFiles) {
    const wasModified = processFile(file);
    processedCount++;
    if (wasModified) {
      modifiedCount++;
    }
  }
  
  console.log(`\n📊 Summary:`);
  console.log(`   Files processed: ${processedCount}`);
  console.log(`   Files modified: ${modifiedCount}`);
  console.log(`   Files unchanged: ${processedCount - modifiedCount}`);
  
  if (modifiedCount > 0) {
    console.log('\n✨ Emoji stripping complete! Your book content is now emoji-free for clean PDF generation.');
  } else {
    console.log('\n✨ All book content files were already emoji-free!');
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { stripEmojis, shouldProcessFile };
