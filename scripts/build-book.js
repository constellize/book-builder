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

// docx post-processing. Pandoc's docx writer has no hook for per-chapter odd-page
// section breaks or for Atkinson list markers, so both are patched into the OOXML after
// the fact. See the docx branch in generateBook() - skipping this call leaves a .docx
// that opens perfectly and is silently wrong.
const { postProcessDocx } = require("./lib/docx-postprocess.js");

class BookBuilder {
  constructor(options = {}) {
    this.options = {
      target: "development",
      verbose: false,
      // Opt-in, and scoped to the target's own output directory - see cleanBuild().
      clean: config.build.clean === true,
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
   * Clean this target's output directory.
   *
   * Scoped deliberately. This used to remove the whole build/ tree, which is why it had
   * to be left permanently disabled: `--target all` constructs one BookBuilder per
   * target, so a whole-tree wipe before each target would leave only the last target's
   * artefact behind and would also destroy artefacts the user had not just rebuilt.
   * build/intermediate/ and build/assets/ are pure scratch and are refreshed on every
   * build regardless of this flag (see processSourceFiles/processImages).
   */
  async cleanBuild() {
    const outputConfig = config.outputs[this.options.target];
    const outputDir = path.resolve(this.rootDir, outputConfig.directory);
    const outputPath = this.getOutputPath();

    if (!(await fs.pathExists(outputDir))) {
      return;
    }

    // Remove ONLY the artefact this target regenerates - never the directory.
    // build/print/ also holds constellize-book-print-preview-2026.01.pdf, a hand-made
    // artefact from 2026-01-03 that no build target reproduces; an fs.remove() of the
    // directory would destroy it silently and unrecoverably. Anything the build does
    // not own is reported and left alone.
    if (await fs.pathExists(outputPath)) {
      console.log(chalk.yellow(`🧹 Removing previous artefact: ${outputPath}`));
      await fs.remove(outputPath);
    }

    const survivors = (await fs.readdir(outputDir)).filter(
      (f) => f !== path.basename(outputPath) && f !== ".DS_Store"
    );
    if (survivors.length > 0) {
      console.log(
        chalk.gray(
          `   Left untouched in ${outputDir} (not build-owned): ${survivors.join(", ")}`
        )
      );
    }
  }

  /**
   * True when the current target is written by pandoc's docx writer.
   *
   * Used in three places that must agree: processSpecialSections() (no \appendix raw
   * LaTeX), generateBook() (the docx branch) and getOutputPath() (".docx"). Derived from
   * outputs[target].format so adding a third docx variant needs no code change.
   */
  isDocxTarget() {
    const outputConfig = config.outputs[this.options.target];
    return !!outputConfig && outputConfig.format === "docx";
  }

  /**
   * Which reference-doc variant ('digital' | 'print') the current docx target uses.
   *
   * This is the key docx-postprocess.js hands to config/docx-styles.js resolve(), which
   * THROWS on an unknown key - so a typo here fails the build rather than producing a
   * docx with the wrong section geometry. Falls back to parsing it out of the target
   * name only if `docxVariant` was omitted from the outputs entry.
   */
  docxVariant() {
    const outputConfig = config.outputs[this.options.target] || {};
    if (outputConfig.docxVariant) {
      return outputConfig.docxVariant;
    }
    const derived = String(this.options.target).replace(/^docx-/, "");
    if (derived === "digital" || derived === "print") {
      return derived;
    }
    throw new Error(
      `Cannot determine the docx variant for target "${this.options.target}". ` +
        `Set docxVariant: 'digital' | 'print' on outputs["${this.options.target}"] ` +
        `in book-builder/config/book.config.js.`
    );
  }

  /**
   * Resolve the Pandoc template for the current target to an absolute path.
   * Returns null when the target intentionally has no template (epub3 uses pandoc's
   * built-in one). A configured-but-missing template is a hard error.
   */
  async resolveTemplate() {
    const templates = (config.pandoc && config.pandoc.templates) || {};
    const configured = templates[this.options.target];

    if (!configured) {
      return null;
    }

    const templatePath = path.resolve(this.rootDir, configured);
    if (!(await fs.pathExists(templatePath))) {
      throw new Error(
        `Pandoc template not found for target "${this.options.target}": ${templatePath}\n` +
          `Fix pandoc.templates in book-builder/config/book.config.js.`
      );
    }
    return templatePath;
  }

  /**
   * Resolve the Lua filters for the current target to absolute paths.
   *
   * A filter that cannot be found is a HARD ERROR. This code used to guard each filter
   * with fs.pathExists and silently skip the ones it could not find, which is how
   * pandoc.filters was able to point at a callout-filter.lua that had never existed:
   * every HTML build quietly emitted unstyled callouts and still exited 0.
   */
  async resolveFilters() {
    const spec = (config.pandoc && config.pandoc.filters) || {};
    const forTarget = Array.isArray(spec) ? spec : spec[this.options.target];

    if (!Array.isArray(forTarget)) {
      throw new Error(
        `No Lua filter list configured for target "${this.options.target}". ` +
          `Add an entry to pandoc.filters in book-builder/config/book.config.js ` +
          `(use [] when a target intentionally declares its filters elsewhere, ` +
          `e.g. inside its pandoc defaults file).`
      );
    }

    const resolved = [];

    for (const entry of forTarget) {
      let candidates = null;
      if (typeof entry === "string") {
        candidates = [entry];
      } else if (entry && Array.isArray(entry.anyOf) && entry.anyOf.length > 0) {
        candidates = entry.anyOf;
      }

      if (!candidates) {
        throw new Error(
          `Invalid pandoc.filters entry for target "${this.options.target}": ` +
            `${JSON.stringify(entry)}. Expected a path string or { anyOf: [paths] }.`
        );
      }

      let found = null;
      for (const candidate of candidates) {
        const candidatePath = path.resolve(this.rootDir, candidate);
        if (await fs.pathExists(candidatePath)) {
          found = candidatePath;
          break;
        }
      }

      if (!found) {
        throw new Error(
          `Lua filter not found for target "${this.options.target}". Looked for:\n` +
            candidates
              .map((c) => `  - ${path.resolve(this.rootDir, c)}`)
              .join("\n") +
            `\nFix pandoc.filters in book-builder/config/book.config.js.`
        );
      }

      resolved.push(found);
    }

    return resolved;
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

    // build/intermediate/ is pure scratch: everything in it is regenerated below from
    // the sources. Reset it every build so a file left behind by an earlier config
    // (a renamed chapter, a stale appendix) cannot leak into the next book.
    const intermediateDir = path.join(this.buildDir, "intermediate");
    await fs.remove(intermediateDir);
    await fs.ensureDir(intermediateDir);

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

    // Generate the References section between the chapters and the appendices.
    // Nothing is read from disk here - see generateReferencesSection().
    await this.generateReferencesSection();

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
   * Generate the References section into build/intermediate/.
   *
   * This is synthesised, not copied. The hand-maintained references.md at the book root
   * is superseded by references.json + citeproc and stays excluded.
   *
   * The generated file is a heading plus an EMPTY `#refs` div. Pandoc's citeproc fills
   * a `#refs` div in place if the document has one, and only falls back to appending an
   * auto-titled bibliography to the very end of the document when it does not. Without
   * this file the bibliography dangled after the last paragraph of the final appendix.
   * With it, the bibliography lands under a visible heading between the chapters and
   * the appendices in PDF, HTML and EPUB alike.
   *
   * The heading is unnumbered so it does not become "Chapter 10" in the numbered PDF
   * (\chapter* also gives the section its own page in the book class).
   */
  async generateReferencesSection() {
    const refsConfig = config.source.references;
    if (!refsConfig || !refsConfig.fileName) {
      return;
    }

    // No bibliography database means nothing for citeproc to place - skip the section
    // rather than emit an empty "References" heading.
    const bibliographyPath = path.resolve(
      this.rootDir,
      (config.citations && config.citations.bibliography) ||
        config.source.bibliography
    );
    if (!(await fs.pathExists(bibliographyPath))) {
      console.log(
        chalk.yellow(
          `⚠️  Bibliography not found (${bibliographyPath}); skipping References section`
        )
      );
      return;
    }

    const title = refsConfig.title || "References";
    const id = refsConfig.id || "references";
    const attrs = [`#${id}`];
    if (refsConfig.unnumbered !== false) {
      attrs.push(".unnumbered");
    }

    const content =
      `# ${title} {${attrs.join(" ")}}\n` +
      `\n` +
      `::: {#refs}\n` +
      `:::\n`;

    const outputPath = path.join(
      this.buildDir,
      "intermediate",
      refsConfig.fileName
    );
    await fs.writeFile(outputPath, content, "utf8");
    console.log(chalk.gray(`Generated ${title} section (${refsConfig.fileName})`));
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
   * Process special sections (foreword, introduction, appendices) for proper numbering.
   *
   * TARGET-AWARE. The LaTeX targets get a raw `\appendix` block spliced in before the
   * first appendix heading, which switches LaTeX's chapter counter to A, B, ... The docx
   * writer DROPS raw LaTeX without a word of warning, so on a docx build that block does
   * nothing and --number-sections happily carries the chapter counter onward: appendix A
   * renders as "10 Appendix A: ..." and appendix B as "11 Appendix B: ...".
   *
   * For docx the appendix H1s are marked {.unnumbered} instead, exactly like Foreword,
   * Introduction and References already are. The prose label "Appendix A:" that this
   * method prepends then carries the identity, which is the whole point of that label.
   */
  processSpecialSections(content, fileName) {
    const isDocx = this.isDocxTarget();

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
        // Only add \appendix for the first appendix (A), and only for writers that
        // understand raw LaTeX. See the method comment: on docx this line is discarded
        // silently and the appendices keep counting up from chapter 9.
        if (appendixLetter === 'A' && !isDocx) {
          lines.splice(insertIndex, 0, '\\appendix\n');
          titleIndex++; // Adjust title index after insertion
        }

        // Update the title to include "Appendix X:"
        if (titleIndex !== -1) {
          const originalTitle = lines[titleIndex]
            .replace(/^# +/, '')
            // Strip any attribute block the source already carries so the rebuilt
            // heading cannot end up with two of them.
            .replace(/\s*\{[^}]*\}\s*$/, '');
          lines[titleIndex] = isDocx
            ? `# Appendix ${appendixLetter}: ${originalTitle} {.unnumbered}`
            : `# Appendix ${appendixLetter}: ${originalTitle}`;
        }
      }
      content = lines.join('\n');
    }

    // Belt and braces for the docx targets: strip any remaining standalone raw-LaTeX
    // line. The \appendix splice above is already skipped, but the SOURCES contain
    // hand-written LaTeX too - ch4.md line 412 is a bare \vspace{1em} used to space a
    // figure in the PDFs. pandoc's markdown reader turns those into RawBlock "tex", the
    // LaTeX writer honours them and the docx writer drops them, so leaving them in is
    // harmless today. It is stripped anyway because "harmless" here depends entirely on
    // the writer silently discarding input, and the next stray command may not be a
    // spacing hint.
    //
    // Deliberately conservative: only a whole line that is nothing but backslash-command
    // (+ optional {...}/[...] arguments) is removed. Inline maths, escaped characters
    // such as \* or \$, and code blocks (which are indented or fenced, never flush-left
    // bare commands) are all left alone.
    if (isDocx) {
      const rawTexLine = /^[ \t]*\\[a-zA-Z]+\*?(?:\[[^\]\n]*\]|\{[^}\n]*\})*[ \t]*$/;
      let stripped = 0;
      content = content
        .split('\n')
        .filter((line) => {
          if (rawTexLine.test(line)) {
            stripped++;
            return false;
          }
          return true;
        })
        .join('\n');
      if (stripped > 0) {
        console.log(
          chalk.gray(`  Stripped ${stripped} raw LaTeX line(s) for docx: ${fileName}`)
        );
      }
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

      // Pandoc runs from book root for all formats, use build/assets/images path
      imageMarkdown = `\n![](build/assets/images/chapters/ch${chapterNum}.png)\n`;
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

      // Pandoc runs from book root for all formats, use build/assets/images path
      imageMarkdown = `\n![](build/assets/images/appendices/app${appendixLetter}.png)\n`;
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

    // Transform inline image paths to absolute build path
    // Pandoc always runs from book root, so use build/assets/images/ for all formats
    content = content.replace(/\(images\//g, '(build/assets/images/');

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
        // pandoc-crossref MUST precede citeproc. Both claim `@`-prefixed keys, and
        // whichever runs first wins. Without this, `@sec:...` cross-references are
        // swallowed by citeproc and emitted as a dangling `#ref-sec:...` anchor with
        // no matching bibliography entry - which is exactly what web and EPUB were
        // doing while both PDFs resolved the same reference correctly.
        // The PDF targets get pandoc-crossref from their defaults files instead.
        pandocArgs.push("--filter=pandoc-crossref");
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
    const isDocxTarget = this.isDocxTarget();

    // Template and Lua filters are resolved per target from book.config.js.
    // Both resolvers throw if a configured file is missing - nothing is skipped.
    const templatePath = await this.resolveTemplate();
    const luaFilters = await this.resolveFilters();

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

    } else if (isDocxTarget) {
      // DOCX-specific settings.
      //
      // THIS BRANCH MUST STAY ABOVE THE HTML `else`. It is not a style preference: the
      // final else pushes --standalone, --embed-resources and (via pandoc.templates)
      // --template=book-template.html5. Handing an HTML5 template to the docx writer
      // produces a .docx that Word opens without complaint and that is complete rubbish.
      //
      // What is deliberately NOT passed here:
      //   --template          the docx writer has no template mechanism; pandoc errors.
      //   --embed-resources   HTML-only; docx already embeds media in the .docx zip.
      //   --standalone        declared in the defaults file; the docx writer is always
      //                       standalone anyway.
      //
      // --toc / --number-sections come from the defaults file (they are the same for
      // both variants), --reference-doc and the Lua filters are per target.
      const defaultsFile = outputConfig.defaultsFile;
      if (!defaultsFile) {
        throw new Error(
          `Target "${this.options.target}" has format "docx" but no defaultsFile. ` +
            `Add one to outputs["${this.options.target}"] in book-builder/config/book.config.js ` +
            `- the shared pandoc-defaults.yaml declares pdf-engine keys and a LaTeX ` +
            `filter chain that make no sense for the docx writer.`
        );
      }
      const defaultsPath = path.resolve(this.rootDir, defaultsFile);
      if (!(await fs.pathExists(defaultsPath))) {
        throw new Error(
          `Pandoc defaults file not found for target "${this.options.target}": ${defaultsPath}`
        );
      }
      pandocArgs.push(`--defaults=${defaultsPath}`);

      // Reference document: styles, embedded Atkinson faces, page geometry. A missing
      // one is a hard error - pandoc would otherwise fall back to its built-in reference
      // doc and emit a Calibri document in which every style the callout filter names
      // (Callout Title, Source Code, ...) resolves to nothing.
      if (!outputConfig.referenceDoc) {
        throw new Error(
          `Target "${this.options.target}" has format "docx" but no referenceDoc. ` +
            `Add one to outputs["${this.options.target}"] in book-builder/config/book.config.js.`
        );
      }
      const referenceDocPath = path.resolve(this.rootDir, outputConfig.referenceDoc);
      if (!(await fs.pathExists(referenceDocPath))) {
        throw new Error(
          `Reference document not found for target "${this.options.target}": ${referenceDocPath}\n` +
            `Build it with: node book-builder/scripts/build-reference-docx.js --variant ${this.docxVariant()}`
        );
      }
      pandocArgs.push(`--reference-doc="${referenceDocPath}"`);

      // Explicit --dpi, matching the PDF branch. The docx writer converts image pixel
      // dimensions to EMU using it, so images scale like they do in the PDFs.
      if (outputConfig.dpi) {
        pandocArgs.push(`--dpi=${outputConfig.dpi}`);
      }

    } else if (outputConfig.format === 'epub3') {
      // EPUB-specific settings
      pandocArgs.push("--standalone");
      pandocArgs.push("--toc");
      // Include metadata file for version, copyright, disclaimer
      const metadataPath = path.resolve(this.toolsDir, 'templates/metadata.yaml');
      pandocArgs.push(`--metadata-file="${metadataPath}"`);
      // EPUB CSS for styling
      const epubCssPath = path.resolve(this.toolsDir, 'styles/epub.css');
      if (await fs.pathExists(epubCssPath)) {
        pandocArgs.push(`--css="${epubCssPath}"`);
      }

    } else {
      // HTML-specific settings
      pandocArgs.push("--standalone");
      pandocArgs.push("--toc");
      // Embed images as base64 data URIs
      pandocArgs.push("--embed-resources");
      // Include metadata file for version, copyright, disclaimer
      const metadataPath = path.resolve(this.toolsDir, 'templates/metadata.yaml');
      pandocArgs.push(`--metadata-file="${metadataPath}"`);
    }

    // Template, if the target has one (epub3 uses pandoc's built-in template).
    // For PDF targets this also overrides whatever `template:` the defaults file
    // declares, which is why the defaults files no longer declare one at all.
    if (templatePath) {
      pandocArgs.push(`--template="${templatePath}"`);
    }

    // Lua filters. Pushed after --citeproc on purpose: citeproc must resolve citations
    // and fill the #refs div BEFORE the callout filter converts callout bodies into raw
    // HTML/LaTeX blocks that later filters can no longer see into.
    for (const filterPath of luaFilters) {
      if (this.options.verbose) {
        console.log(chalk.gray(`Lua filter: ${filterPath}`));
      }
      pandocArgs.push(`--lua-filter="${filterPath}"`);
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

    // ------------------------------------------------------------------
    // docx post-processing. NOT OPTIONAL.
    //
    // Pandoc's docx writer offers no way to (a) start each chapter on a recto page,
    // (b) point list markers at the embedded Atkinson faces, or (c) give the table of
    // contents field a cached result. docx-postprocess.js patches all three into
    // word/document.xml, word/numbering.xml and word/styles.xml after the fact - it
    // clones the sectPr pandoc actually wrote rather than inventing one, so it stays
    // correct if the reference doc's page setup changes.
    //
    // If this call is removed or silently swallowed, the .docx still opens, still has
    // every chapter, and is still the right size. It simply loses openright, renders
    // bullets in Symbol, and shows a BLANK Contents page. That is exactly the class of
    // failure this whole pipeline keeps producing, so any error here fails the build
    // loudly instead of warning.
    //
    // The TOC's page numbers are the one part that needs Microsoft Word (it is the only
    // thing on this machine that can paginate the document). That dependency is SOFT by
    // design: without Word the build still succeeds and ships a fully clickable Contents
    // with no page numbers, and says so. See the TOC section of docx-postprocess.js.
    // ------------------------------------------------------------------
    if (isDocxTarget) {
      const variant = this.docxVariant();
      console.log(chalk.yellow(`🔧 Post-processing docx (${variant})...`));
      let result;
      try {
        result = postProcessDocx({
          docxPath: outputPath,
          variant,
          // commander turns `--no-toc-page-numbers` into tocPageNumbers === false.
          tocPageNumbers: this.options.tocPageNumbers === false ? "never" : "auto",
          log: (msg) => console.log(chalk.gray(`   ${msg}`)),
        });
      } catch (error) {
        throw new Error(
          `docx post-processing failed for target "${this.options.target}": ${error.message}\n` +
            `The .docx at ${outputPath} is INCOMPLETE - it has no odd-page chapter breaks ` +
            `and its list markers still point at the default fonts. Do not ship it.`
        );
      }
      console.log(
        chalk.gray(
          `   ${result.sections} chapter section break(s), ` +
            `${result.levels} numbering level(s) patched ` +
            `(${result.bullets} bullet, ${result.ordered} ordered), ` +
            `${result.toc.entries} TOC entries` +
            (result.toc.pageNumbers ? " with page numbers" : " WITHOUT page numbers") +
            `, ${(result.bytes / 1024).toFixed(1)} KiB`
        )
      );

      // A docx with zero inserted section breaks means insertChapterSections() found no
      // chapter Heading1 to break on - the writer, the reference doc or the style names
      // changed underneath it. Nothing downstream would notice.
      if (!result.sections) {
        throw new Error(
          `docx post-processing inserted 0 chapter section breaks into ${outputPath}. ` +
            `Expected one per chapter. Check that pandoc is still emitting Heading1 ` +
            `paragraphs and that config/docx-styles.js matches the reference document.`
        );
      }

      // A Contents with no page numbers is a legitimate, shippable degradation - but it
      // is NOT what this target is for, and it must never pass unremarked. Loud, with
      // the reason and the one command that fixes it.
      if (!result.toc.pageNumbers) {
        console.warn(
          chalk.yellow(
            `\n⚠  The Contents in ${outputPath} has working links but NO PAGE NUMBERS.\n` +
              `   Reason: ${result.toc.warning}\n` +
              `   The book is complete and shippable; only the page numbers are missing.\n` +
              `   To add them, make Microsoft Word available and re-run:\n` +
              `     node book-builder/scripts/lib/docx-postprocess.js ${outputPath} --variant ${variant}\n` +
              `   Or, in Word: Ctrl-A then F9 updates every field by hand.\n`
          )
        );
      }
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

    // Add the generated References section after the chapters but before the appendices
    const referencesName =
      (config.source.references && config.source.references.fileName) ||
      "references.md";
    const referencesFile = path.join(intermediateDir, referencesName);
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
      case "docx":
        // Without this case the `default` below names the file .html and pandoc writes
        // docx bytes into it. Word will not open it and nothing in the build complains.
        extension = ".docx";
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
    "build target (digital, print, web, development, epub, docx-digital, docx-print, pdf, all)",
    "development"
  )
  .option("-v, --verbose", "verbose output", false)
  // Cleaning is opt-in and scoped to the target's own output directory. `--no-clean` is
  // kept so existing invocations keep working; it is now simply the default. Declaring
  // --clean first is what stops commander flipping the default back to true.
  .option(
    "--clean",
    "remove this target's output directory before building",
    config.build.clean === true
  )
  .option("--no-clean", "do not remove the output directory (default)")
  // docx targets only. The Contents page numbers are computed by asking Word to
  // paginate the document; there is nothing else on any platform that can. That
  // dependency is soft - without Word the build ships a fully clickable Contents
  // with no page numbers and says so - and this flag makes the same choice
  // deliberately, which is what a CI run that has Word installed but does not want
  // to pay 6s (or drive a GUI app) should use.
  .option(
    "--no-toc-page-numbers",
    "docx targets: skip the Word pagination step; ship a Contents with working " +
      "links but no page numbers"
  )
  .action(async (options) => {
    if (options.target === "all") {
      // Build every published target. Must include BOTH pdf variants and BOTH docx
      // variants: publish-to-website.sh copies build/digital/constellize-book.pdf,
      // build/print/constellize-book.pdf, build/docx-digital/constellize-book.docx and
      // build/docx-print/constellize-book.docx.
      const targets = config.allTargets || [
        "digital",
        "print",
        "web",
        "development",
        "epub",
        "docx-digital",
        "docx-print",
      ];
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
