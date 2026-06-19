# Changelog

## [1.3.2] - 2026-06-19

### Changed
- `ifBlockHighlight.scopeBars`: the scope bars are now rendered as thin (1px) vertical guide lines anchored to the indentation column of each `IF` block (like bracket-pair guides), instead of stacked flush against the left margin. Nested blocks now get their own colored line, staggered to the right, which makes each block's scope much easier to follow.
- `ifBlockHighlight.scopeBars`: the bars are now drawn as an absolutely-positioned overlay so they always stay on top of the editor's native indentation guides (including the white active-indent guide), which previously hid the bar when both fell on the same column.
- `ifBlockHighlight.scopeBars`: the bars are now shown only for the IF blocks that contain the cursor line (matching the behavior of the IF/ELSE/END-IF keyword boxes), reducing visual noise on files with many IF statements. When the cursor is nested deep, all enclosing blocks' bars are shown.

### Fixed
- `ifBlockHighlight.scopeBars`: the colored scope bars are now actually rendered. They were never drawn because the decoration used the unsupported `borderLeft` shorthand, which the VS Code decoration API ignores.
- IF block scope detection now correctly closes nested blocks when an `END-IF` is missing: an `ELSE` is paired with the innermost `IF` that does not yet have one (COBOL semantics), implicitly closing already-complete inner blocks. Previously the outer block was left open until the terminating period, so the scope bar overshot to the end of the paragraph.

## [1.3.1] - 2026-06-15

### Changed
- Marketplace discoverability: refreshed the extension `description` and `keywords` (added `micro focus`, `rocket cobol`, `enterprise developer`, `go to definition`, `navigation`, `intellisense`, `fixed format`, `variable format`).
- Hover tooltips are now localized and follow the `cobolLens.language` setting (`auto`/`it`/`en`), matching the linter behavior. Labels such as variable/group type, line, size, and the copybook hover text are shown in Italian or English accordingly.

### Added
- README: Marketplace badges (version, installs, downloads, rating) and a `Feedback and Community` section linking to bug reports, feature requests, and GitHub Discussions.
- `CONTRIBUTING.md` with guidance on reporting bugs, proposing features and linter rules, and running the tests.
- GitHub issue templates for bug reports and feature requests, plus a discussions/marketplace contact-links config.
- `SECURITY.md` with a security policy pointing to GitHub private vulnerability reporting.

### Fixed
- Go to Definition, Find All References and hover now work when a single `.CBL` file is opened without an open workspace folder: the file folder is used as the root instead of returning no symbols.
- `undefined-variable`: no longer reports false positives for words inside an unterminated string literal (for example when the closing quote falls beyond column 72 in fixed format). The literal content is now stripped up to the end of the line.

## [1.3.0] - 2026-06-15

### Added
- Hover now shows the size in bytes of a field or group. Hovering over a group item without a PIC (e.g. `01 WS-SAVE-CHIAVE` with `02` sub-fields) displays the total area size as the sum of its sub-fields (e.g. `Dimensione area: 22 byte`); hovering over an elementary item shows its own size (e.g. `Dimensione: 4 byte`).
- Size computation handles `DISPLAY`, `COMP-3`/`PACKED-DECIMAL`, `COMP`/`COMP-4`/`COMP-5`/`BINARY`, `COMP-1`, `COMP-2`, `INDEX` and `POINTER` usages, `OCCURS n` multiplication, nested sub-groups, and `FILLER` fields. `REDEFINES` items and levels 66/88 are excluded from the total.
- Size computation also supports data items defined across multiple physical lines (continuation lines are joined) and groups that include a nested `COPY` (the copybook fields are expanded inline and counted in the group total).

## [1.2.2] - 2026-06-11

### Fixed
- Rule `move-alphanumeric-to-numeric`: table subscript/index in destination (e.g. `MOVE ALFA TO TABLE-FIELD (I2)`) was incorrectly flagged -- `I2` is an index, not the destination variable. Parenthesized subscripts and reference modifications are now stripped before checking destination types.

## [1.2.1] - 2026-06-10

### Fixed
- Rule `move-alphanumeric-to-numeric` now also classifies variables defined in copybooks: a `MOVE` of an alphanumeric value into a numeric field declared via `COPY` (e.g. `MOVE 'TEST' TO WS-NUM` where `WS-NUM PIC 9(n)` lives in a copybook) is now correctly reported
- Rule `alphanumeric-in-compute` benefits from the same fix: alphanumeric variables declared in copybooks are now recognized in arithmetic statements
- `REPLACING` clauses on the `COPY` are applied when classifying copybook variables

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
