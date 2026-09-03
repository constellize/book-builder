/**
 * Constellize Book Configuration
 * Main configuration for book processing with Pandoc
 */

const path = require('path');

// Lua filter that renders callouts for the HTML-family writers (html5 + epub3).
//
// `anyOf` = candidate list, first existing wins. If NONE of the candidates exist the
// build fails loudly (see BookBuilder.resolveFilters()); filters are never silently
// skipped. The candidate list exists because the HTML/EPUB callout rendering may live
// either in a dedicated callout-filter-html.lua or in callout-filter-digital.lua,
// which carries both a LaTeX and an HTML branch.
const CALLOUT_FILTER_HTML = {
  anyOf: [
    'book-builder/templates/filters/callout-filter-html.lua',
    'book-builder/templates/filters/callout-filter-digital.lua'
  ]
};

const LINK_FILTER = 'book-builder/templates/filters/link-filter.lua';

// Callout filters for the docx writer. These are NOT interchangeable with the LaTeX or
// HTML ones: the docx writer drops raw LaTeX silently and renders raw HTML as nothing,
// so a callout filter that emits either produces a .docx that opens cleanly with the
// callout bodies simply missing. The docx filters emit raw OpenXML `<w:tbl>` boxes
// instead - 156 of them, which is what verify-docx.js counts.
//
// Plain strings, not { anyOf: [...] } - there is no acceptable fallback. If the docx
// callout filter is missing the build MUST stop, because every alternative filter fails
// silently for this writer.
const CALLOUT_FILTER_DOCX_DIGITAL =
  'book-builder/templates/filters/callout-filter-docx-digital.lua';
const CALLOUT_FILTER_DOCX_PRINT =
  'book-builder/templates/filters/callout-filter-docx-print.lua';

module.exports = {
  // Book metadata
  book: {
    title: "Constellize: Top Down Development, Reimagined",
    subtitle: "Building Software Systems from Knowledge",
    author: "Steve Atkinson",
    version: "1.0.0",
    isbn: "", // To be filled when available
    publisher: "Constellize Press",
    year: new Date().getFullYear()
  },

  // Source paths (relative to project root)
  source: {
    root: path.resolve(__dirname, '../..'),
    foreword: 'foreword-faq.md', // Foreword comes first
    introduction: 'introduction.md', // Introduction after foreword, before chapters
    chapters: ['ch[1-9].md'], // Main chapters (1-9)
    bibliography: 'references.json', // Bibliography database (CSL-JSON)

    // References section. This section is GENERATED, it is not read from disk.
    // build-book.js writes build/intermediate/<fileName> containing an unnumbered
    // heading plus an empty `#refs` div. Pandoc's citeproc fills that div in place,
    // which is what puts the bibliography after the chapters and before the
    // appendices instead of dangling at the very end of the book with no heading.
    // The old hand-maintained references.md at the book root is NOT used - it stays
    // in excludePatterns below.
    references: {
      fileName: 'references.md', // written into build/intermediate/
      title: 'References',
      id: 'references',
      unnumbered: true
    },

    appendices: ['app[AB].md'], // Appendices (A-B only, others migrated to website)
    codebase: './codepromptu',
    images: './images',
    media: './media',
    excludePatterns: [
      'book-builder/**',
      'build/**', 
      'node_modules/**',
      '.git/**',
      '*.tmp',
      'narrative-*.md',
      'chapter-image-design-plan.md',
      'ch1-revised.md',
      'ch4a.md',
      'example-chapter.md',
      'README-teaser.md',
      'tone.md',
      'references.md' // Exclude old manual references file
    ]
  },

  // Repository configuration for link processing
  repository: {
    // CodePromptu repository - for code examples and implementation
    // Replaced in {CODEPROMPTU_REPO_BASE} placeholders  
    codepromptuBaseUrl: process.env.CODEPROMPTU_REPO_BASE_URL || "https://github.com/nowucca/codepromptu/blob/main",
    
    // Constellize website - for prompts, templates, book resources, and online content
    // Replaced in {SITE_BASE} placeholders
    siteBaseUrl: process.env.SITE_BASE_URL || "https://constellize.com",
    
    localPath: "./codepromptu", // for development builds
    branch: "main"
  },

  // Output configurations for different targets
  outputs: {
    digital: {
      directory: './build/digital',
      codepromptuRepoBaseUrl: 'https://github.com/nowucca/codepromptu/blob/main',
      siteBaseUrl: 'https://constellize.com',
      format: 'pdf',
      engine: 'xelatex',
      dpi: 300,
      pdfType: 'interactive', // Enable hyperlinks and bookmarks
      standalone: true,
      defaultsFile: 'book-builder/config/pandoc-defaults-digital.yaml'
    },
    print: {
      directory: './build/print',
      codepromptuRepoBaseUrl: 'https://github.com/nowucca/codepromptu/blob/main',
      siteBaseUrl: 'https://constellize.com',
      format: 'pdf',
      engine: 'xelatex',
      dpi: 300,
      pdfType: 'x1a', // PDF/X-1a compliance for printing
      colorProfile: 'FOGRA39',
      standalone: true,
      defaultsFile: 'book-builder/config/pandoc-defaults-print.yaml'
    },
    web: {
      directory: './build/web',
      codepromptuRepoBaseUrl: 'https://github.com/nowucca/codepromptu/blob/main',
      siteBaseUrl: 'https://constellize.com',
      format: 'html5',
      standalone: true
    },
    development: {
      directory: './build/development',
      codepromptuRepoBaseUrl: 'file://' + path.resolve(__dirname, '../../codepromptu'),
      siteBaseUrl: 'http://localhost:5173', // Local development server
      format: 'html5',
      standalone: true
    },
    epub: {
      directory: './build/epub',
      codepromptuRepoBaseUrl: 'https://github.com/nowucca/codepromptu/blob/main',
      siteBaseUrl: 'https://constellize.com',
      format: 'epub3',
      standalone: true
    },

    // Word (.docx) targets.
    //
    // Every key below is MANDATORY, not optional-with-a-default:
    //   - `directory` is dereferenced without a guard by createBuildDirectories() and
    //     cleanBuild().
    //   - `codepromptuRepoBaseUrl` / `siteBaseUrl` are dereferenced without a guard by
    //     processRepositoryLinks(); omitting them leaves literal {SITE_BASE} placeholders
    //     in the prose and costs ~67 prompt hyperlinks.
    //   - `format: 'docx'` is what selects the docx branch in generateBook() and the
    //     ".docx" case in getOutputPath(). Any other value silently produces an .html
    //     file with docx bytes in it, or a docx run through the HTML template.
    //   - `referenceDoc` supplies --reference-doc: styles, the embedded Atkinson faces,
    //     page geometry. Without it pandoc uses its built-in reference doc and the
    //     result is a Calibri document with none of the callout or code styles the Lua
    //     filters reference by name.
    //   - `defaultsFile` supplies the reader extension string, toc and number-sections.
    //     It must be the docx one; the LaTeX defaults carry pdf-engine keys.
    //
    // digital and print differ ONLY in their reference doc (Hyperlink style) and their
    // callout filter. They write to SEPARATE directories so `--target all` cannot have
    // one overwrite the other.
    'docx-digital': {
      directory: './build/docx-digital',
      codepromptuRepoBaseUrl: 'https://github.com/nowucca/codepromptu/blob/main',
      siteBaseUrl: 'https://constellize.com',
      format: 'docx',
      dpi: 300,
      standalone: true,
      // Consumed by generateBook() -> --reference-doc, and by docx-postprocess.js via
      // `docxVariant` below (which selects the matching entry in config/docx-styles.js).
      referenceDoc: 'book-builder/templates/docx/reference-digital.docx',
      docxVariant: 'digital',
      defaultsFile: 'book-builder/config/pandoc-defaults-docx-digital.yaml'
    },
    'docx-print': {
      directory: './build/docx-print',
      codepromptuRepoBaseUrl: 'https://github.com/nowucca/codepromptu/blob/main',
      siteBaseUrl: 'https://constellize.com',
      format: 'docx',
      dpi: 300,
      standalone: true,
      referenceDoc: 'book-builder/templates/docx/reference-print.docx',
      docxVariant: 'print',
      defaultsFile: 'book-builder/config/pandoc-defaults-docx-print.yaml'
    },
    // Alias for 'digital'. It writes to the SAME directory as 'digital', so it must
    // produce the same artefact - hence it repeats digital's defaultsFile rather than
    // falling back to pandoc.defaultsFile (which declares a different filter chain and
    // no pandoc-crossref). Kept only for backwards compatibility with `--target pdf`;
    // it is deliberately NOT part of `--target all`, which builds digital + print.
    pdf: {
      directory: './build/digital', // Default to digital format
      codepromptuRepoBaseUrl: 'https://github.com/nowucca/codepromptu/blob/main',
      siteBaseUrl: 'https://constellize.com',
      format: 'pdf',
      engine: 'xelatex',
      dpi: 300,
      pdfType: 'interactive',
      standalone: true,
      defaultsFile: 'book-builder/config/pandoc-defaults-digital.yaml'
    }
  },

  // Targets built by `--target all` / `npm run build:all`.
  // Must cover every artefact that publish-to-website.sh copies: both PDFs, the web
  // HTML, the EPUB and both .docx manuscripts. The 'pdf' alias is excluded because it
  // writes to build/digital and would just rebuild the same file twice.
  allTargets: [
    'digital',
    'print',
    'web',
    'development',
    'epub',
    'docx-digital',
    'docx-print'
  ],

  // Pandoc configuration
  pandoc: {
    // Fallback defaults file for any target that does not declare its own
    // `defaultsFile` in `outputs` above. Every PDF target now declares one, so this is
    // only a safety net.
    defaultsFile: 'book-builder/config/pandoc-defaults.yaml',

    // Pandoc templates, resolved per target. A target with no entry here gets no
    // --template flag and therefore uses pandoc's built-in template for its format;
    // that is deliberate for epub3. A configured template that does not exist on disk
    // is a hard error (see BookBuilder.resolveTemplate()).
    templates: {
      digital: 'book-builder/templates/book-digital.latex',
      pdf: 'book-builder/templates/book-digital.latex',
      print: 'book-builder/templates/book-print.latex',
      web: 'book-builder/templates/book-template.html5',
      development: 'book-builder/templates/book-template.html5'
      // epub: pandoc's built-in epub3 template
      // docx-digital / docx-print: DELIBERATELY ABSENT. The docx writer has no template
      // mechanism - its equivalent is --reference-doc, declared per target in `outputs`
      // above. Adding an entry here would make generateBook() pass --template to a docx
      // build, which pandoc rejects outright.
    },

    // Lua filters, resolved per target. Every target MUST have an entry; an unlisted
    // target is a hard error rather than a silent "no filters" build.
    //
    // The PDF targets are intentionally empty: pandoc-defaults-digital.yaml and
    // pandoc-defaults-print.yaml already declare their own `filters:` chains
    // (pandoc-crossref, minted, the matching callout filter, link-filter, citeproc).
    // Repeating them here would apply each filter twice.
    filters: {
      digital: [],
      print: [],
      pdf: [],
      web: [CALLOUT_FILTER_HTML, LINK_FILTER],
      development: [CALLOUT_FILTER_HTML, LINK_FILTER],
      epub: [CALLOUT_FILTER_HTML, LINK_FILTER],

      // The docx targets DO declare their filters here rather than in their defaults
      // files, unlike the PDF targets. generateBook() emits, in command-line order,
      //   --filter=pandoc-crossref --citeproc --lua-filter=callout --lua-filter=link
      // and pandoc honours that order, so citations resolve and the #refs div is filled
      // before the callout filter turns callout bodies into tables the later filters
      // can no longer see into. Putting citeproc in the defaults file instead risks the
      // top-level-`citeproc:` mistake that silently reverted all 28 citations to literal
      // "[@key]" text in the digital PDF.
      'docx-digital': [CALLOUT_FILTER_DOCX_DIGITAL, LINK_FILTER],
      'docx-print': [CALLOUT_FILTER_DOCX_PRINT, LINK_FILTER]
    },

    metadata: 'book-builder/templates/metadata.yaml'
  },

  // Citation configuration
  citations: {
    bibliography: 'references.json', // Bibliography database file
    defaultStyle: 'chicago', // Default citation style
    styles: {
      apa: 'book-builder/styles/citations/apa.csl',
      chicago: 'book-builder/styles/citations/chicago-author-date.csl',
      ieee: 'book-builder/styles/citations/ieee.csl'
    },
    // Style per output format (optional overrides)
    outputStyles: {
      digital: 'chicago',
      print: 'chicago',
      pdf: 'chicago',
      web: 'chicago',
      development: 'chicago',
      epub: 'chicago',
      'docx-digital': 'chicago',
      'docx-print': 'chicago'
    }
  },

  // Font configuration for Atkinson Hyperlegible
  fonts: {
    main: {
      name: "Atkinson Hyperlegible Next",
      path: "book-builder/fonts/",
      files: {
        // Using AtkinsonHyperlegibleNext fonts
        regular: "AtkinsonHyperlegibleNext-Regular",
        bold: "AtkinsonHyperlegibleNext-Bold", 
        italic: "AtkinsonHyperlegibleNext-RegularItalic",
        boldItalic: "AtkinsonHyperlegibleNext-BoldItalic"
      },
      formats: {
        pdf: "ttf",
        web: "woff2", // Preferred for web
        development: "woff2", // Use WOFF2 for development too
        fallback: "ttf"
      }
    },
    mono: {
      name: "Atkinson Hyperlegible Mono",
      path: "book-builder/fonts/",
      files: {
        regular: "AtkinsonHyperlegibleMono-Regular",
        bold: "AtkinsonHyperlegibleMono-Bold",
        italic: "AtkinsonHyperlegibleMono-RegularItalic", 
        boldItalic: "AtkinsonHyperlegibleMono-BoldItalic"
      },
      formats: {
        pdf: "ttf",
        web: "woff2",
        development: "woff2",
        fallback: "ttf"
      }
    }
  },

  // Callout system configuration
  callouts: {
    codeReference: {
      icon: "📁",
      title: "Code Reference",
      style: "info",
      color: "#0066cc"
    },
    architecture: {
      icon: "🏗️", 
      title: "System Architecture",
      style: "primary",
      color: "#6f42c1"
    },
    narrative: {
      icon: "📖",
      title: "Narrative Context", 
      style: "secondary",
      color: "#6c757d"
    },
    implementation: {
      icon: "⚡",
      title: "Implementation Pattern",
      style: "success", 
      color: "#28a745"
    },
    crossReference: {
      icon: "🔗",
      title: "Related Components",
      style: "warning",
      color: "#ffc107"
    }
  },

  // Image processing settings
  images: {
    dpi: 300,
    formats: ['png', 'jpg', 'jpeg', 'svg'],
    optimization: {
      quality: 90,
      progressive: true
    }
  },

  // Build settings
  build: {
    // Default for the --clean flag. Cleaning is OPT-IN and is scoped to the current
    // target's own output directory (build/<target>/), never the whole build/ tree:
    // `--target all` runs one BookBuilder per target, so a whole-tree clean would
    // delete every artefact except the last target's.
    clean: false,
    verbose: false,
    parallel: true, // Process chapters in parallel where possible
    watch: false // Enable file watching in development
  }
};
