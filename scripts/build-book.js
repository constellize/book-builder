#!/usr/bin/env node

/**
 * Constellize Book Builder
 * Main build script for processing the book with Pandoc
 */

const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const { program } = require("commander");
const chalk = require("chalk");
const glob = require("glob");

// Import configuration
const config = require("../config/book.config.js");

// Import emoji validation
const { validateEmojis } = require("./validate-emojis.js");

class BookBuilder {
  constructor(options = {}) {
    this.options = {
      target: "development",
      verbose: false,
      clean: true,
      ...options,
    };

    this.rootDir = config.source.root;
    this.buildDir = path.resolve(this.rootDir, "build");
    // book-builder directory is the parent of the scripts directory
    this.toolsDir = path.resolve(__dirname, "..");
  }

  /**
   * Main build process
   */
  async build() {
    try {
      console.log(
        chalk.blue(`🚀 Building Constellize Book (${this.options.target})`)
      );

      // Validate prerequisites
      await this.validatePrerequisites();

      // Validate emoji usage (quality gate)
      await this.validateEmojiUsage();

      // Clean build directory if requested
      if (this.options.clean) {
        await this.cleanBuild();
      }

      // Create build directories
      await this.createBuildDirectories();

      // Process source files
      await this.processSourceFiles();

      // Process images
      await this.processImages();

      // Generate the book
      await this.generateBook();

      console.log(chalk.green(`✅ Book built successfully!`));
      console.log(chalk.gray(`Output: ${this.getOutputPath()}`));
    } catch (error) {
      console.error(chalk.red(`❌ Build failed: ${error.message}`));
      if (this.options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  }

  /**
   * Validate that required tools are available
   */
  async validatePrerequisites() {
    console.log(chalk.yellow("🔍 Validating prerequisites..."));

    // Check Pandoc
    try {
      const pandocVersion = execSync("pandoc --version", { encoding: "utf8" });
      console.log(chalk.gray(`Pandoc: ${pandocVersion.split("\n")[0]}`));
    } catch (error) {
      throw new Error(
        "Pandoc is not installed. Please install Pandoc 3.0+ to continue."
      );
    }

    // Check XeLaTeX for PDF builds (including new targets)
    const outputConfig = config.outputs[this.options.target];
    const isPdfTarget = outputConfig && outputConfig.format === 'pdf';
    
    if (isPdfTarget || this.options.target === "all") {
      try {
        // Try with extended PATH for macOS TeX Live
        const extendedPath =
          process.env.PATH +
          ":/usr/local/texlive/2025/bin/universal-darwin:/usr/local/texlive/2024/bin/universal-darwin:/usr/local/texlive/2023/bin/universal-darwin";
        const xelatexVersion = execSync("xelatex --version", {
          encoding: "utf8",
          env: { ...process.env, PATH: extendedPath },
        });
        console.log(chalk.gray(`XeLaTeX: ${xelatexVersion.split("\n")[0]}`));
      } catch (error) {
        throw new Error(
          "XeLaTeX is not installed. Please install MacTeX or TeX Live for PDF generation."
        );
      }
    }

    // Check fonts
    await this.validateFonts();
  }

  /**
   * Validate that required fonts are available
   */
  async validateFonts() {
    const fontPath = path.resolve(this.toolsDir, "fonts");
    const fontFiles = config.fonts.main.files;
    const targetFormat =
      config.fonts.main.formats[this.options.target] ||
      config.fonts.main.formats.fallback;

    for (const [style, baseName] of Object.entries(fontFiles)) {
      const fontFile = path.join(fontPath, `${baseName}.${targetFormat}`);
      if (!(await fs.pathExists(fontFile))) {
        console.warn(
          chalk.yellow(`⚠️  Font not found: ${baseName}.${targetFormat}`)
        );
        console.log(chalk.gray("Place font files in tools/fonts/ directory"));
        console.log(
          chalk.gray(
            `For ${
              this.options.target
            }: Use ${targetFormat.toUpperCase()} format`
          )
        );
      }
    }
  }

  /**
   * Validate emoji usage in book content files (quality gate)
   */
  async validateEmojiUsage() {
    try {
      // Run emoji validation - this will throw an error if validation fails
      validateEmojis();
    } catch (error) {
      throw new Error(`Emoji validation failed: ${error.message}`);
    }
  }

  /**
   * Clean the build directory
   */
  async cleanBuild() {
    console.log(chalk.yellow("🧹 Cleaning build directory..."));
    await fs.remove(this.buildDir);
  }

  /**
   * Create necessary build directories
   */
  async createBuildDirectories() {
    const outputConfig = config.outputs[this.options.target];
    const outputDir = path.resolve(this.rootDir, outputConfig.directory);

    await fs.ensureDir(outputDir);
    await fs.ensureDir(path.join(this.buildDir, "intermediate"));
    await fs.ensureDir(path.join(this.buildDir, "assets"));
  }

  /**
   * Process source markdown files
   */
  async processSourceFiles() {
    console.log(chalk.yellow("📝 Processing source files..."));

    const allFiles = [];

    // Add foreword first if it exists
    if (config.source.foreword) {
      const forewordPath = path.resolve(this.rootDir, config.source.foreword);
      if (await fs.pathExists(forewordPath)) {
        allFiles.push(forewordPath);
        console.log(chalk.gray("Added foreword"));
      }
    }

    // Add introduction after foreword if it exists
    if (config.source.introduction) {
      const introductionPath = path.resolve(this.rootDir, config.source.introduction);
      if (await fs.pathExists(introductionPath)) {
        allFiles.push(introductionPath);
        console.log(chalk.gray("Added introduction"));
      }
    }

    // Add chapters
    for (const pattern of config.source.chapters) {
      const chapterPattern = path.resolve(this.rootDir, pattern);
      const chapterFiles = glob.sync(chapterPattern).sort();
      allFiles.push(...chapterFiles);
    }

    // Add references after chapters if it exists
    if (config.source.references) {
      const referencesPath = path.resolve(this.rootDir, config.source.references);
      if (await fs.pathExists(referencesPath)) {
        allFiles.push(referencesPath);
        console.log(chalk.gray("Added references"));
      }
    }

    // Add appendices
    for (const pattern of config.source.appendices) {
      const appendixPattern = path.resolve(this.rootDir, pattern);
      const appendixFiles = glob.sync(appendixPattern).sort();
      allFiles.push(...appendixFiles);
    }

    console.log(chalk.gray(`Found ${allFiles.length} source files`));

    // Process each file
    for (const file of allFiles) {
      await this.processSourceFile(file);
    }
  }

  /**
   * Process a single source file
   */
  async processSourceFile(filePath) {
    const fileName = path.basename(filePath);
    const outputPath = path.join(this.buildDir, "intermediate", fileName);

    console.log(chalk.gray(`Processing: ${fileName}`));

    // Read source file
    let content = await fs.readFile(filePath, "utf8");

    // Handle special formatting for foreword and appendices
    content = this.processSpecialSections(content, fileName);

    // Add chapter image if this is a chapter
    content = await this.addChapterImage(content, fileName);

    // Process repository links
    content = this.processRepositoryLinks(content);

    // Process callouts
    content = this.processCallouts(content);

    // Write processed file
    await fs.writeFile(outputPath, content, "utf8");
  }

  /**
   * Process special sections (foreword, introduction, appendices) for proper numbering
   */
  processSpecialSections(content, fileName) {
    // Handle foreword - make it unnumbered
    if (fileName === 'foreword-faq.md') {
      // Convert the first ## **Foreword** to # Foreword {.unnumbered}
      content = content.replace(/^## \*\*Foreword\*\*$/m, '# Foreword {.unnumbered}');
      
      // Convert all other ## headings to ## headings with {.unnumbered}
      content = content.replace(/^## \*\*([^*]+)\*\*$/gm, '## $1 {.unnumbered}');
      
      // Convert ### headings to ## headings with {.unnumbered}
      content = content.replace(/^### (.+)$/gm, '## $1 {.unnumbered}');
    }

    // Handle introduction - make it unnumbered like the foreword
    if (fileName === 'introduction.md') {
      // Convert the first # Introduction to # Introduction {.unnumbered}
      content = content.replace(/^# Introduction$/m, '# Introduction {.unnumbered}');
      
      // Convert all ## headings to ## headings with {.unnumbered}
      content = content.replace(/^## (.+)$/gm, '## $1 {.unnumbered}');
      
      // Convert ### headings to ### headings with {.unnumbered}
      content = content.replace(/^### (.+)$/gm, '### $1 {.unnumbered}');
    }

    // Handle appendices - add appendix marker and fix titles
    const appendixMatch = fileName.match(/^app([A-G])\.md$/);
    if (appendixMatch) {
      const appendixLetter = appendixMatch[1];
      const lines = content.split('\n');
      let insertIndex = -1;
      let titleIndex = -1;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('# ')) {
          insertIndex = i;
          titleIndex = i;
          break;
        }
      }

      if (insertIndex !== -1) {
        // Only add \appendix for the first appendix (A)
        if (appendixLetter === 'A') {
          lines.splice(insertIndex, 0, '\\appendix\n');
          titleIndex++; // Adjust title index after insertion
        }
        
        // Update the title to include "Appendix X:"
        if (titleIndex !== -1) {
          const originalTitle = lines[titleIndex].replace(/^# +/, '');
          lines[titleIndex] = `# Appendix ${appendixLetter}: ${originalTitle}`;
        }
      }
      content = lines.join('\n');
    }

    return content;
  }

  /**
   * Add chapter or appendix image to content if available
   */
  async addChapterImage(content, fileName) {
    let imagePath = null;
    let imageMarkdown = "";
    let logMessage = "";

    // Handle chapters (ch1.md, ch2.md, etc.)
    const chapterMatch = fileName.match(/^ch(\d+)\.md$/);
    if (chapterMatch) {
      const chapterNum = chapterMatch[1];
      imagePath = path.resolve(
        this.rootDir,
        "images",
        "chapters",
        `ch${chapterNum}.png`
      );

      // For PDF, Pandoc runs from root dir, so we need build/assets/images path
      // For HTML, use relative path from output HTML to build/assets
      // Remove alt text to avoid captions
      const outputConfig = config.outputs[this.options.target];
      const isPdfTarget = outputConfig && outputConfig.format === 'pdf';
      
      if (isPdfTarget) {
        // PDF: Pandoc runs from root, processes build/intermediate/*.md, needs build/assets/images
        imageMarkdown = `\n![](build/assets/images/chapters/ch${chapterNum}.png)\n`;
      } else {
        // HTML output is in build/development/ or build/web/, so path to build/assets is ../assets
        imageMarkdown = `\n![](../assets/images/chapters/ch${chapterNum}.png)\n`;
      }
      logMessage = `  Added chapter image for ch${chapterNum}`;
    }

    // Handle appendices (appA.md, appB.md, etc.)
    const appendixMatch = fileName.match(/^app([A-G])\.md$/);
    if (appendixMatch) {
      const appendixLetter = appendixMatch[1];
      imagePath = path.resolve(
        this.rootDir,
        "images",
        "appendices",
        `app${appendixLetter}.png`
      );

      // Same logic for appendices - remove alt text to avoid captions
      const outputConfig = config.outputs[this.options.target];
      const isPdfTarget = outputConfig && outputConfig.format === 'pdf';
      
      if (isPdfTarget) {
        imageMarkdown = `\n![](build/assets/images/appendices/app${appendixLetter}.png)\n`;
      } else {
        imageMarkdown = `\n![](../assets/images/appendices/app${appendixLetter}.png)\n`;
      }
      logMessage = `  Added appendix image for app${appendixLetter}`;
    }

    // If no image path was determined, return content unchanged
    if (!imagePath) {
      return content;
    }

    // Check if image exists
    if (await fs.pathExists(imagePath)) {
      // Find the first heading (chapter/appendix title)
      const lines = content.split("\n");
      let insertIndex = -1;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("# ")) {
          insertIndex = i + 1;
          break;
        }
      }

      if (insertIndex !== -1) {
        // Insert image after the title
        lines.splice(insertIndex, 0, imageMarkdown);
        content = lines.join("\n");
        console.log(chalk.gray(logMessage));
      }
    }

    return content;
  }

  /**
   * Process repository placeholders in content
   * Handles {CODEPROMPTU_REPO_BASE} and {SITE_BASE}
   */
  processRepositoryLinks(content) {
    const outputConfig = config.outputs[this.options.target];
    
    // Replace {CODEPROMPTU_REPO_BASE} with CodePromptu repository URL
    const codepromptuRepoBaseUrl = outputConfig.codepromptuRepoBaseUrl || config.repository.codepromptuBaseUrl;
    content = content.replace(/{CODEPROMPTU_REPO_BASE}/g, codepromptuRepoBaseUrl);
    
    // Replace {SITE_BASE} with Constellize website URL
    const siteBaseUrl = outputConfig.siteBaseUrl || config.repository.siteBaseUrl;
    content = content.replace(/{SITE_BASE}/g, siteBaseUrl);

    // Transform inline image paths based on output format
    // Convert images/... paths to build/assets/images/... for PDF or ../assets/images/... for HTML
    const isPdfTarget = outputConfig && outputConfig.format === 'pdf';
    
    if (isPdfTarget) {
      // PDF: Pandoc runs from root, needs build/assets/images path
      content = content.replace(/\(images\//g, '(build/assets/images/');
    } else {
      // HTML: Output is in build/{target}/, needs ../assets/images path
      content = content.replace(/\(images\//g, '(../assets/images/');
    }

    return content;
  }

  /**
   * Process custom callout syntax
   */
  processCallouts(content) {
    // This is a basic implementation - the Lua filters will do the heavy lifting
    // We could add preprocessing here if needed
    return content;
  }

  /**
   * Process images for the target format
   */
  async processImages() {
    console.log(chalk.yellow("🖼️  Processing images..."));

    const imagesDir = path.resolve(this.rootDir, "images");
    const outputImagesDir = path.join(this.buildDir, "assets", "images");

    if (await fs.pathExists(imagesDir)) {
      await fs.copy(imagesDir, outputImagesDir);
      console.log(chalk.gray("Images copied to build directory"));
    }
  }

  /**
   * Generate the final book using Pandoc
   */
  async generateBook() {
    console.log(chalk.yellow("📚 Generating book with Pandoc..."));

    const outputConfig = config.outputs[this.options.target];
    const outputPath = this.getOutputPath();

    // Build Pandoc command - different approach for HTML vs PDF vs EPUB
    let pandocArgs = ["pandoc"];

    // Get all intermediate files in correct order
    const intermediateFiles = await this.getIntermediateFilesInOrder();
    pandocArgs.push(...intermediateFiles.map((f) => `"${f}"`));

    // Output format and file
    pandocArgs.push(`--to=${outputConfig.format}`);
    pandocArgs.push(`--output="${outputPath}"`);

    // Add citation processing for all formats
    // Note: For PDF targets, citeproc is included in the defaults file filters
    // We only need to provide bibliography and CSL paths
    if (config.citations) {
      const outputConfig = config.outputs[this.options.target];
      const isPdfBuild = outputConfig && outputConfig.format === 'pdf';
      
      // Only add --citeproc for non-PDF builds (PDF has it in defaults filters)
      if (!isPdfBuild) {
        pandocArgs.push("--citeproc");
      }
      
      // Add bibliography
      const bibliographyPath = path.resolve(this.rootDir, config.citations.bibliography);
      if (await fs.pathExists(bibliographyPath)) {
        pandocArgs.push(`--bibliography="${bibliographyPath}"`);
      }
      
      // Add citation style
      const citationStyle = config.citations.outputStyles[this.options.target] || config.citations.defaultStyle;
      const stylePath = path.resolve(this.rootDir, config.citations.styles[citationStyle]);
      if (await fs.pathExists(stylePath)) {
        pandocArgs.push(`--csl="${stylePath}"`);
      }
    }

    // Check if this is a PDF target (including new targets)
    const isPdfTarget = outputConfig.format === 'pdf';

    if (isPdfTarget) {
      // PDF-specific settings
      // Use target-specific defaults file if specified, otherwise use global defaults
      const defaultsFile = outputConfig.defaultsFile || config.pandoc.defaultsFile;
      pandocArgs.push(
        `--defaults=${path.resolve(this.rootDir, defaultsFile)}`
      );
      pandocArgs.push(`--pdf-engine=${outputConfig.engine}`);
      pandocArgs.push(`--pdf-engine-opt=-shell-escape`); // Required for Minted syntax highlighting
      pandocArgs.push(`--dpi=${outputConfig.dpi}`);
      
      // Choose template based on PDF type
      let templatePath;
      if (outputConfig.pdfType === 'x1a' || this.options.target === 'print') {
        templatePath = path.resolve(this.toolsDir, 'templates/book-print.latex');
      } else {
        templatePath = path.resolve(this.toolsDir, 'templates/book-digital.latex');
      }
      pandocArgs.push(`--template="${templatePath}"`);
      
    } else if (outputConfig.format === 'epub3') {
      // EPUB-specific settings
      pandocArgs.push("--standalone");
      pandocArgs.push("--toc");
      pandocArgs.push(`--metadata title="${config.book.title}"`);
      pandocArgs.push(`--metadata author="${config.book.author}"`);
      
    } else {
      // HTML-specific settings
      pandocArgs.push("--standalone");
      pandocArgs.push("--toc");
      pandocArgs.push(
        `--css=${path.resolve(this.toolsDir, "styles/book.css")}`
      );
      pandocArgs.push(`--metadata title="${config.book.title}"`);
      pandocArgs.push(`--metadata author="${config.book.author}"`);

      // Add filters for HTML
      for (const filter of config.pandoc.filters) {
        const filterPath = path.resolve(this.rootDir, filter);
        if (await fs.pathExists(filterPath)) {
          pandocArgs.push(`--lua-filter="${filterPath}"`);
        }
      }
    }
    
    // Pass repository URL patterns to filters via metadata (for link detection)
    // Extract domain/path patterns from the full URLs in config
    const codepromptuPattern = config.repository.codepromptuBaseUrl.replace(/^https?:\/\//, '').replace(/\/blob\/main$/, '');
    const sitePattern = config.repository.siteBaseUrl.replace(/^https?:\/\//, '');
    
    pandocArgs.push(`--metadata=codepromptu-repo-pattern:${codepromptuPattern}`);
    pandocArgs.push(`--metadata=site-pattern:${sitePattern}`);

    const pandocCommand = pandocArgs.join(" ");

    if (this.options.verbose) {
      console.log(chalk.gray(`Command: ${pandocCommand}`));
    }

    try {
      const execOptions = {
        stdio: this.options.verbose ? "inherit" : "pipe",
        cwd: this.rootDir,
      };

      // For PDF builds, extend PATH to include TeX Live and Python venv
      if (isPdfTarget) {
        const venvPath = path.resolve(this.toolsDir, '.venv/bin');
        const extendedPath =
          venvPath + ':' +
          process.env.PATH +
          ":/usr/local/texlive/2025/bin/universal-darwin:/usr/local/texlive/2024/bin/universal-darwin:/usr/local/texlive/2023/bin/universal-darwin";
        execOptions.env = { ...process.env, PATH: extendedPath };
      }

      execSync(pandocCommand, execOptions);
    } catch (error) {
      throw new Error(`Pandoc failed: ${error.message}`);
    }
  }

  /**
   * Get intermediate files in the correct order
   */
  async getIntermediateFilesInOrder() {
    const intermediateDir = path.join(this.buildDir, "intermediate");
    const files = [];

    // Add foreword first
    if (config.source.foreword) {
      const forewordFile = path.join(intermediateDir, config.source.foreword);
      if (await fs.pathExists(forewordFile)) {
        files.push(forewordFile);
      }
    }

    // Add introduction after foreword
    if (config.source.introduction) {
      const introductionFile = path.join(intermediateDir, config.source.introduction);
      if (await fs.pathExists(introductionFile)) {
        files.push(introductionFile);
      }
    }

    // Add chapters in order
    for (let i = 1; i <= 9; i++) {
      const chapterFile = path.join(intermediateDir, `ch${i}.md`);
      if (await fs.pathExists(chapterFile)) {
        files.push(chapterFile);
      }
    }

    // Add references after chapters but before appendices
    const referencesFile = path.join(intermediateDir, "references.md");
    if (await fs.pathExists(referencesFile)) {
      files.push(referencesFile);
    }

    // Add appendices in order
    for (const letter of ["A", "B", "C", "D", "E", "F", "G"]) {
      const appendixFile = path.join(intermediateDir, `app${letter}.md`);
      if (await fs.pathExists(appendixFile)) {
        files.push(appendixFile);
      }
    }

    return files;
  }

  /**
   * Get the output file path for the current target
   */
  getOutputPath() {
    const outputConfig = config.outputs[this.options.target];
    const outputDir = path.resolve(this.rootDir, outputConfig.directory);

    let fileName = "constellize-book";
    let extension = "";

    switch (outputConfig.format) {
      case "pdf":
        extension = ".pdf";
        break;
      case "html5":
        extension = ".html";
        break;
      case "epub3":
        extension = ".epub";
        break;
      default:
        extension = ".html";
    }

    return path.join(outputDir, fileName + extension);
  }
}

// CLI setup
program
  .name("build-book")
  .description("Build the Constellize book using Pandoc")
  .version("1.0.0")
  .option(
    "-t, --target <target>",
    "build target (web, pdf, development, epub, all)",
    "development"
  )
  .option("-v, --verbose", "verbose output", false)
  .option("--no-clean", "skip cleaning build directory", false)
  .action(async (options) => {
    if (options.target === "all") {
      // Build all targets
      const targets = ["web", "pdf", "development", "epub"];
      for (const target of targets) {
        const builder = new BookBuilder({ ...options, target });
        await builder.build();
      }
    } else {
      const builder = new BookBuilder(options);
      await builder.build();
    }
  });

// Run if called directly
if (require.main === module) {
  program.parse();
}

module.exports = BookBuilder;
