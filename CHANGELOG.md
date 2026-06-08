# Changelog

## [1.1.0] - 2026-06-08

### Added
- Diagnostic messages are now available in both Italian and English
- New setting `cobolLens.language`: `"auto"` (detect from VS Code locale), `"it"` (Italian), `"en"` (English)
- When set to `"auto"`, the language is detected from `vscode.env.language`
- Settings descriptions are now localized (Italian and English) and follow the VS Code display language

## [1.0.1] - 2026-06-08

### Fixed
- Replaced corrupted special characters in README with ASCII equivalents
- Removed .vscode from repository (local-only config)

## [1.0.0] - 2026-06-08

### Features
- Go to Definition for COPY statements, variables, paragraphs and sections
- Peek Definition (Alt+F12) with inline preview
- Find All References (Shift+F12) across main file and copybooks
- Hover with type info, source file, and copybook preview
- Copybook autocomplete after COPY keyword
- Code folding for DIVISION, SECTION and paragraphs
- Document Symbols provider (Outline panel)
- Recursive copybook resolution with REPLACING support
- Clickable document links for COPY statements
- Configurable copy folders and extensions
- IF/ELSE/END-IF block visualization with colored scope bars (9 nesting levels)
- Integrated COBOL linter with 30+ configurable rules
- Linter runs in real-time (debounced) or on save
- Missing copybook diagnostics in Problems panel
