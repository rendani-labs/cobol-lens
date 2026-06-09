# Changelog

## [1.2.0] - 2026-06-09

### Added
- New linter rule `move-alphanumeric-to-numeric`: flags a `MOVE` of an alphanumeric value into a numeric variable
- Detects alphanumeric literals (e.g. `'ABC'`), alphanumeric figurative constants (`SPACES`, `HIGH-VALUES`, `LOW-VALUES`, `QUOTES`) and alphanumeric variables (PIC X/A) moved into numeric fields (PIC 9)
- `FUNCTION NUMVAL` / `NUMVAL-C` conversions are excluded (treated as legitimate)
- Purely numeric literals (e.g. `'123'`), `ZERO`/`ZEROS` and `MOVE CORRESPONDING` are not reported to avoid false positives

### Changed
- The `missing-period` rule now also checks the PROCEDURE DIVISION: it flags a statement that is missing its terminating period before the next paragraph or section header

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
