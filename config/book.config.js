/**
 * Constellize Book Configuration
 * Main configuration for book processing with Pandoc
 */

const path = require('path');

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
    chapters: ['ch[1-9].md'], // Main chapters (1-9)
    bibliography: 'references.json', // Bibliography database (CSL-JSON)
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
    // Alias for 'digital' format
    pdf: {
      directory: './build/digital', // Default to digital format
      codepromptuRepoBaseUrl: 'https://github.com/nowucca/codepromptu/blob/main',
      siteBaseUrl: 'https://constellize.com',
      format: 'pdf',
      engine: 'xelatex',
      dpi: 300,
      pdfType: 'interactive',
      standalone: true
    }
  },

  // Pandoc configuration
  pandoc: {
    defaultsFile: 'book-builder/config/pandoc-defaults.yaml',
    template: 'book-builder/templates/book.latex',
    filters: [
      'book-builder/templates/filters/callout-filter.lua',
      'book-builder/templates/filters/link-filter.lua'
    ],
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
      epub: 'chicago'
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
    clean: true, // Clean build directory before building
    verbose: false,
    parallel: true, // Process chapters in parallel where possible
    watch: false // Enable file watching in development
  }
};
