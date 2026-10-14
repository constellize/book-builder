# Project Brief: Book-Builder

**Project Name**: Book-Builder - Reusable Pandoc + XeLaTeX Build System
**Created**: December 25, 2024
**Current Version**: 1.0.0
**Status**: Active - Extracted from Constellize Book project

---

## Project Vision

Create a reusable, production-ready build system for technical book authors who want professional-quality PDF, HTML, and EPUB outputs from Markdown source files. The system should be self-contained, well-documented, and easy to integrate into any book project.

---

## Core Objectives

### Primary Goal
Provide a turnkey solution for building technical books that handles the complexity of Pandoc, XeLaTeX, fonts, templates, and output formats while being reusable across multiple book projects.

### Specific Objectives

1. **Multi-Format Output**
   - PDF (both digital and print-ready)
   - HTML (web viewing)
   - EPUB (e-readers)
   - Consistent quality across all formats

2. **Self-Contained System**
   - Include all necessary fonts (Atkinson Hyperlegible)
   - Include LaTeX templates and Lua filters
   - Include CSS and citation styles
   - Minimal external dependencies

3. **Easy Integration**
   - Git submodule or standalone usage
   - Simple configuration via metadata.yaml
   - Clear documentation and examples
   - Sensible defaults

4. **Professional Quality**
   - Typography optimized for readability
   - Proper handling of code blocks, callouts, citations
   - PDF/X-1a compliance for print
   - Accessibility considerations

5. **Maintainability**
   - Clean script organization
   - Comprehensive validation tools
   - Error handling and troubleshooting guides
   - Version control friendly

---

## Success Criteria

### Technical Success
- ✅ Builds PDF, HTML, EPUB from Markdown
- ✅ Includes all dependencies (fonts, templates)
- ✅ Works as git submodule
- ✅ Configurable via metadata.yaml
- ✅ Validates content (links, emojis, structure)

### Quality Success
- ✅ Professional typography
- ✅ Proper code formatting
- ✅ Callout boxes with colored backgrounds
- ✅ Citation management
- ✅ Cross-references work correctly

### Usability Success
- ✅ Clear documentation
- ✅ Example projects included
- ✅ Simple npm scripts interface
- ✅ Helpful error messages
- ✅ Troubleshooting guide

---

## Scope

### In Scope

**Build Capabilities**:
- PDF generation (digital and print)
- HTML generation (single-page and multi-page)
- EPUB generation
- Validation tools (links, emojis, structure)
- Image processing (DPI, formats)

**Content Support**:
- Markdown with Pandoc extensions
- Code blocks with syntax highlighting
- Callout boxes (info, warning, caution, note, example)
- Citations and bibliography
- Cross-references and internal links
- Images and figures
- Tables

**Integration**:
- Git submodule usage
- Standalone repository usage
- Configuration via YAML
- npm scripts interface

**Documentation**:
- Comprehensive README
- Example projects
- Troubleshooting guide
- API documentation

### Out of Scope

**Not Included**:
- Book content itself (user provides)
- Writing/editing tools
- Collaborative editing features
- Version control system (users bring their own git)
- Web hosting or distribution
- E-commerce or sales infrastructure
- Custom template creation tools (users can modify templates directly)

**Future Considerations**:
- GUI interface for configuration
- Template marketplace
- Additional output formats (AsciiDoc, DocBook)
- Integration with writing tools (Obsidian, etc.)
- Automated deployment to publishing platforms

---

## Constraints

### Technical Constraints
- Requires Pandoc 3.0+
- Requires XeLaTeX (TeX Live distribution)
- Requires Node.js 16+
- macOS and Linux primary platforms (Windows experimental)
- Font files included (~10MB) increase repo size

### Design Constraints
- Must work as git submodule
- Must be configurable without code changes
- Must not require users to install fonts system-wide
- Templates must support both digital and print output

### Quality Constraints
- PDF must meet PDF/X-1a standards for print
- Code must handle long lines without overflow
- Emojis must be validated for PDF compatibility
- Links must be validated before build

---

## Stakeholders

### Primary Stakeholders
- **Technical Book Authors**: Need professional publishing tools
- **Constellize Book Project**: Original use case, ongoing user
- **Open Source Community**: Potential contributors and users

### Secondary Stakeholders
- **Publishers**: May adopt for author toolchains
- **Documentation Teams**: Could use for technical docs
- **Course Creators**: Could use for educational materials

---

## Key Features

### Core Features (Version 1.0)
- Multi-format build system (PDF, HTML, EPUB)
- Atkinson Hyperlegible fonts included
- LaTeX templates for book formatting
- Lua filters for content processing
- Validation tools (links, emojis, structure)
- Example projects
- Comprehensive documentation

### Recent Enhancements
- **Emoji Validation** (Dec 25, 2024): Enhanced to properly exclude node_modules from validation scans

---

## Risks and Mitigation

### High Priority Risks

**Risk**: Pandoc/XeLaTeX version compatibility issues
**Mitigation**: Document version requirements, test with multiple versions

**Risk**: Font licensing concerns
**Mitigation**: Use open-source Atkinson Hyperlegible fonts with clear license

**Risk**: Template complexity intimidates users
**Mitigation**: Provide good defaults, clear examples, hide complexity

**Risk**: Build errors hard to debug
**Mitigation**: Comprehensive error messages, troubleshooting guide

### Medium Priority Risks

**Risk**: Platform-specific issues (Windows)
**Mitigation**: Document as experimental on Windows, provide workarounds

**Risk**: Submodule workflow confusion
**Mitigation**: Clear documentation, helper scripts

**Risk**: Template customization breaks builds
**Mitigation**: Validation tools, example modifications

---

## Timeline

### Version 1.0 (Current)
- **Released**: December 25, 2024
- **Status**: Extracted from Constellize Book project
- **Features**: Core build system with all essential features

### Future Versions
- **1.1**: Additional template options, improved error handling
- **1.2**: Multi-page HTML support, improved EPUB
- **2.0**: GUI configuration, template marketplace

---

## Resources

### Technical Stack
- **Pandoc**: Document conversion
- **XeLaTeX**: PDF generation
- **Node.js**: Build scripts
- **Git**: Version control and submodules
- **npm**: Package management and scripts

### Dependencies
- fs-extra, glob, yaml, sharp, chalk, commander, chokidar, express

### Documentation
- README.md (comprehensive guide)
- examples/ (sample projects)
- templates/ (LaTeX and Lua)
- scripts/ (build and validation tools)

---

## Current Status

**Version**: 1.0.0
**Status**: Active, production-ready
**Origin**: Extracted from Constellize Book project (Phase 0)
**Git History**: Preserved from original book repository
**Repository**: https://github.com/constellize/book-builder

**Recent Work**:
- Extracted from book/tools/ with full git history
- Set up as standalone repository and git submodule
- Enhanced emoji validation (Dec 25, 2024)
- Ready for use in Constellize Book and other projects

---

**Document Owner**: Steve Atkinson
**Last Updated**: December 25, 2024
**Next Review**: After version 1.1 release
