#!/usr/bin/env node

/**
 * Build Single Chapter/File Script
 * 
 * Usage:
 *   node scripts/build-single.js <input-file> [format] [output-name]
 * 
 * Examples:
 *   node scripts/build-single.js ../ch1.md pdf chapter1
 *   node scripts/build-single.js ../example-chapter.md html example
 *   node scripts/build-single.js ../ch1.md all chapter1
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Import main configuration
const bookConfig = require('../config/book.config.js');

// Configuration (URLs derived from main config)
const config = {
  texLivePath: '/usr/local/texlive/2025/bin/universal-darwin',
  buildDir: '../build',
  // CodePromptu repository URLs (from main config)
  codepromptuRepoBase: {
    pdf: bookConfig.repository.codepromptuBaseUrl,
    html: bookConfig.repository.codepromptuBaseUrl,
    web: bookConfig.repository.codepromptuBaseUrl,
    epub: bookConfig.repository.codepromptuBaseUrl,
    development: bookConfig.outputs.development.codepromptuRepoBaseUrl
  },
  // Constellize website URLs (from main config)
  siteBase: {
    pdf: bookConfig.repository.siteBaseUrl,
    html: bookConfig.repository.siteBaseUrl,
    web: bookConfig.repository.siteBaseUrl,
    epub: bookConfig.repository.siteBaseUrl,
    development: bookConfig.outputs.development.siteBaseUrl
  }
};

function showUsage() {
  console.log(`
🚀 Build Single Chapter/File

Usage:
  node scripts/build-single.js <input-file> [format] [output-name]

Arguments:
  input-file    Path to markdown file (relative to book root)
  format        Output format: pdf, html, epub, development, all (default: pdf)
  output-name   Output filename without extension (default: derived from input)

Examples:
  node scripts/build-single.js ../ch1.md pdf chapter1
  node scripts/build-single.js ../example-chapter.md html example
  node scripts/build-single.js ../ch1.md all chapter1
  node scripts/build-single.js ../example-chapter.md

Formats:
  pdf          - PDF with Atkinson Hyperlegible fonts
  html         - Web-ready HTML
  epub         - EPUB e-book format
  development  - HTML with local file links
  all          - Generate all formats
`);
}

function validatePrerequisites() {
  console.log('🔍 Validating prerequisites...');
  
  try {
    const pandocVersion = execSync('pandoc --version', { encoding: 'utf8' });
    console.log(`Pandoc: ${pandocVersion.split('\n')[0]}`);
  } catch (error) {
    console.error('❌ Pandoc not found. Please install Pandoc.');
    process.exit(1);
  }

  if (fs.existsSync(config.texLivePath)) {
    try {
      const xelatexVersion = execSync(`${config.texLivePath}/xelatex --version`, { encoding: 'utf8' });
      console.log(`XeLaTeX: ${xelatexVersion.split('\n')[0]}`);
    } catch (error) {
      console.log('⚠️  XeLaTeX not found. PDF generation may fail.');
    }
  } else {
    console.log('⚠️  TeX Live not found at expected path. PDF generation may fail.');
  }
}

function ensureBuildDirectories() {
  const dirs = ['pdf', 'html', 'epub', 'development'].map(d => path.join(config.buildDir, d));
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function processContent(inputFile, format) {
  console.log(`📝 Processing ${inputFile} for ${format}...`);
  
  let content = fs.readFileSync(inputFile, 'utf8');
  
  // Replace {CODEPROMPTU_REPO_BASE} with CodePromptu repository URL
  const codepromptuRepoBaseUrl = config.codepromptuRepoBase[format] || config.codepromptuRepoBase.pdf;
  content = content.replace(/\{CODEPROMPTU_REPO_BASE\}/g, codepromptuRepoBaseUrl);
  
  // Replace {SITE_BASE} with Constellize website URL
  const siteBaseUrl = config.siteBase[format] || config.siteBase.pdf;
  content = content.replace(/\{SITE_BASE\}/g, siteBaseUrl);
  
  // Convert blockquote callouts to proper callout syntax
  content = content.replace(/^> \*\*📁 Code Reference:(.*?)\*\*$([\s\S]*?)(?=^(?:[^>]|$))/gm, (match, title, body) => {
    const cleanBody = body.replace(/^> ?/gm, '').trim();
    return `\n::: codeReference\n**Code Reference${title}**\n\n${cleanBody}\n:::\n`;
  });
  
  content = content.replace(/^> \*\*🏗️ System Architecture:(.*?)\*\*$([\s\S]*?)(?=^(?:[^>]|$))/gm, (match, title, body) => {
    const cleanBody = body.replace(/^> ?/gm, '').trim();
    return `\n::: architecture\n**System Architecture${title}**\n\n${cleanBody}\n:::\n`;
  });
  
  content = content.replace(/^> \*\*📖 Narrative Context:(.*?)\*\*$([\s\S]*?)(?=^(?:[^>]|$))/gm, (match, title, body) => {
    const cleanBody = body.replace(/^> ?/gm, '').trim();
    return `\n::: narrative\n**Narrative Context${title}**\n\n${cleanBody}\n:::\n`;
  });
  
  content = content.replace(/^> \*\*⚡ Implementation Pattern:(.*?)\*\*$([\s\S]*?)(?=^(?:[^>]|$))/gm, (match, title, body) => {
    const cleanBody = body.replace(/^> ?/gm, '').trim();
    return `\n::: implementation\n**Implementation Pattern${title}**\n\n${cleanBody}\n:::\n`;
  });
  
  content = content.replace(/^> \*\*🔗 Related Components:\*\*$([\s\S]*?)(?=^(?:[^>]|$))/gm, (match, body) => {
    const cleanBody = body.replace(/^> ?/gm, '').trim();
    return `\n::: crossreference\n**Related Components:**\n\n${cleanBody}\n:::\n`;
  });
  
  return content;
}

function buildFormat(inputFile, format, outputName) {
  const content = processContent(inputFile, format);
  
  // Create absolute paths
  const buildDir = path.resolve(__dirname, config.buildDir);
  const tempFile = path.join(buildDir, 'temp-input.md');
  const outputDir = path.join(buildDir, format);
  
  // Ensure directories exist
  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(tempFile, content);
  
  let outputFile, pandocArgs;
  
  switch (format) {
    case 'pdf':
      outputFile = path.join(outputDir, `${outputName}.pdf`);
      pandocArgs = [
        tempFile,
        '-o', outputFile,
        '--pdf-engine=xelatex',
        '--template=../templates/book.latex',
        '--lua-filter=../templates/filters/callout-filter.lua',
        '--lua-filter=../templates/filters/link-filter.lua',
        '--metadata', 'title="Constellize Book"',
        '--metadata', 'author="Your Name"',
        '--dpi=300',
        '--standalone'
      ];
      break;
      
    case 'html':
      outputFile = path.join(outputDir, `${outputName}.html`);
      pandocArgs = [
        tempFile,
        '-o', outputFile,
        '--lua-filter=templates/filters/callout-filter.lua',
        '--lua-filter=templates/filters/link-filter.lua',
        '--metadata', 'title="Constellize Book"',
        '--css=../styles/book.css',
        '--standalone',
        '--toc'
      ];
      break;
      
    case 'development':
      outputFile = path.join(outputDir, `${outputName}.html`);
      pandocArgs = [
        tempFile,
        '-o', outputFile,
        '--lua-filter=templates/filters/callout-filter.lua',
        '--lua-filter=templates/filters/link-filter.lua',
        '--metadata', 'title="Constellize Book (Development)"',
        '--css=../styles/book.css',
        '--standalone',
        '--toc'
      ];
      break;
      
    case 'epub':
      outputFile = path.join(outputDir, `${outputName}.epub`);
      pandocArgs = [
        tempFile,
        '-o', outputFile,
        '--lua-filter=templates/filters/callout-filter.lua',
        '--lua-filter=templates/filters/link-filter.lua',
        '--metadata', 'title="Constellize Book"',
        '--metadata', 'author="Your Name"',
        '--toc'
      ];
      break;
      
    default:
      throw new Error(`Unknown format: ${format}`);
  }
  
  console.log(`📚 Generating ${format.toUpperCase()}...`);
  
  try {
    const env = { ...process.env };
    if (format === 'pdf') {
      env.PATH = `${config.texLivePath}:${env.PATH}`;
    }
    
    execSync(`pandoc ${pandocArgs.join(' ')}`, { 
      stdio: 'inherit',
      env: env,
      cwd: path.dirname(__filename)
    });
    
    console.log(`✅ ${format.toUpperCase()} generated: ${outputFile}`);
    return outputFile;
  } catch (error) {
    console.error(`❌ Failed to generate ${format.toUpperCase()}: ${error.message}`);
    throw error;
  } finally {
    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showUsage();
    return;
  }
  
  const inputFile = args[0];
  const format = args[1] || 'pdf';
  const outputName = args[2] || path.basename(inputFile, path.extname(inputFile));
  
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ Input file not found: ${inputFile}`);
    process.exit(1);
  }
  
  console.log(`🚀 Building ${inputFile} as ${format}`);
  
  validatePrerequisites();
  ensureBuildDirectories();
  
  try {
    if (format === 'all') {
      const formats = ['pdf', 'html', 'epub', 'development'];
      const outputs = [];
      
      for (const fmt of formats) {
        try {
          const output = buildFormat(inputFile, fmt, outputName);
          outputs.push(output);
        } catch (error) {
          console.error(`⚠️  Failed to build ${fmt}, continuing...`);
        }
      }
      
      console.log('\n🎉 Build complete!');
      console.log('Generated files:');
      outputs.forEach(file => console.log(`  - ${file}`));
      
    } else {
      const output = buildFormat(inputFile, format, outputName);
      console.log(`\n🎉 Build complete: ${output}`);
    }
    
  } catch (error) {
    console.error(`\n❌ Build failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildFormat, processContent };
