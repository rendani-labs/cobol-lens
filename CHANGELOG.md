# Changelog

## [1.11.0] - 2026-07-14

### Added
- Hover for condition names (`88` level): hovering a level-88 item now shows the parent data item it qualifies and its `VALUE`(s), including value lists and `THRU` ranges. Conversely, hovering a data item that owns condition names lists them with their values, so you can see all the `88` flags of a field at a glance.

## [1.10.0] - 2026-07-14

### Added
- Program-to-program navigation on `CALL` statements: Go to Definition (`F12` / `Ctrl+Click`) and clickable links now resolve the called program to its source file in the workspace. Both literal calls (`CALL 'PROGNAME'` / `CALL "PROGNAME"`) and indirect calls through a data item are supported; for an indirect call the target variable is resolved to its `VALUE` literal when available. Comment lines and `END-CALL` are ignored, and an unresolved `CALL variable` still falls back to jumping to the variable definition.
- Two new settings control the lookup, mirroring the copybook resolution:
  - `cobolLens.programFolders`: folders (relative to the workspace root) to search for called programs (empty string = workspace root).
  - `cobolLens.programExtensions`: extensions to try when resolving called programs (empty string = no extension).
- Signature Help now recognizes the full set of COBOL intrinsic functions (over 90), covering the ISO 2014/2023 standard and Micro Focus / Rocket extensions: formatted date/time (`FORMATTED-DATE`, `FORMATTED-DATETIME`, `FORMATTED-TIME`, `FORMATTED-CURRENT-DATE`, `INTEGER-OF-FORMATTED-DATE`, `SECONDS-FROM-FORMATTED-TIME`, `SECONDS-PAST-MIDNIGHT`), financial (`ANNUITY`, `PRESENT-VALUE`), statistics (`STANDARD-DEVIATION`, `VARIANCE`, `MIDRANGE`), math constants (`PI`, `E`), sign/parts (`SIGN`, `FRACTION-PART`, `HIGHEST-ALGEBRAIC`, `LOWEST-ALGEBRAIC`), exception (`EXCEPTION-FILE`, `EXCEPTION-LOCATION`, `EXCEPTION-STATEMENT`, `EXCEPTION-STATUS`), validation (`TEST-NUMVAL`, `TEST-NUMVAL-C`, `TEST-NUMVAL-F`, `TEST-DATE-YYYYMMDD`, `TEST-DAY-YYYYDDD`, `TEST-FORMATTED-DATETIME`), locale (`LOCALE-COMPARE`, `LOCALE-DATE`, `LOCALE-TIME`, `LOCALE-TIME-FROM-SECONDS`), national/Unicode (`NATIONAL-OF`, `DISPLAY-OF`, `CHAR-NATIONAL`, `ULENGTH`, `UPOS`, `USUBSTR`, `UVALID`, `UWIDTH`, `USUPPLEMENTARY`), and more (`CONCATENATE`, `SUBSTITUTE`, `BYTE-LENGTH`, `STORED-CHAR-LENGTH`, `NUMVAL-F`, `COMBINED-DATETIME`, `STANDARD-COMPARE`, `BOOLEAN-OF-INTEGER`, `INTEGER-OF-BOOLEAN`).

### Fixed
- Formatter on copybooks: a copybook that contains only a data layout (level numbers `01/05/...` without the `DATA DIVISION` header) is now indented hierarchically with the `PIC` clauses aligned, instead of being flattened to Area A with misplaced `PIC` columns. Any line that starts with a level number (or `FD/SD/RD/CD`, or continues an open data clause) is now treated as a data item even outside an explicit `DATA DIVISION`.

## [1.9.0] - 2026-07-13

### Added
- Document Highlight: placing the cursor on a symbol (variable, paragraph or section) now highlights every occurrence of that name in the current file. The definition, when it is in the same file, is marked as a write occurrence. Comments and string literals are ignored. Controlled by the new `cobolLens.documentHighlight.enabled` setting (on by default).
- Signature Help for COBOL intrinsic functions: while typing a `FUNCTION name(...)` call the editor shows the parameter hints for the function, with the current argument highlighted (it follows the commas, handles nested calls, and ignores commas inside string literals). Covers a curated set of common Micro Focus / Rocket intrinsic functions (`LENGTH`, `NUMVAL`, `NUMVAL-C`, `MOD`, `REM`, `MAX`, `MIN`, `SUM`, `MEAN`, `MEDIAN`, `SQRT`, `ABS`, `INTEGER`, `TRIM`, `UPPER-CASE`, `LOWER-CASE`, `REVERSE`, date/time and trigonometric functions, and more). Controlled by the new `cobolLens.signatureHelp.enabled` setting (on by default).

### Fixed
- Syntax highlighting: date literals (e.g. `2026-07-14`) after `DATE-WRITTEN`, `DATE-COMPILED` and similar IDENTIFICATION DIVISION headers are now highlighted with the same color as the `PROGRAM-ID` value instead of appearing in plain white.

## [1.8.0] - 2026-07-13

### Added
- Seven new semantic linter rules (all configurable via `cobolLens.linter.rules.<rule>.enabled` / `.severity`):
  - `duplicate-paragraph` (error): two paragraphs with the same name in the same section, which makes `PERFORM` ambiguous. Scope is reset at each `SECTION` boundary, so the same name in different sections is allowed.
  - `alter-statement` (warning): use of the `ALTER` statement, which rewrites a `GO TO` target at runtime and makes control flow unpredictable.
  - `next-sentence` (warning): use of `NEXT SENTENCE`, deprecated and fragile; use `CONTINUE` instead.
  - `evaluate-without-when-other` (warning): an `EVALUATE` closed by `END-EVALUATE` that has no `WHEN OTHER` default branch. Nested `EVALUATE` blocks are handled; `EVALUATE` closed by a period is not flagged to avoid false positives.
  - `perform-varying-without-until` (warning): a `PERFORM VARYING` with no `UNTIL` clause (risk of an infinite loop). The `UNTIL` is also detected on continuation lines.
  - `level-88-without-parent` (error): a level `88` condition-name that is not subordinate to any parent data item.
  - `move-truncation` (warning): a `MOVE` into a destination with a smaller `PIC` (silent truncation). Conservative: it compares only pure alphanumeric or pure numeric elementary items (no editing symbols, no `OCCURS`, no subscripts/reference modification), and copybook fields are included.
- The integrated linter now ships 47 rules (was 40).

## [1.7.0] - 2026-06-25

### Added
- Inline suppression comments for linter diagnostics. Inside a COBOL comment (either a full-line comment with `*`/`/` in column 7, or an inline `*>` comment) you can now write directives to silence specific rules:
  - `cobol-lens-disable-next-line [rules...]` suppresses the given rules on the next code line.
  - `cobol-lens-disable-line [rules...]` suppresses the given rules on the current line (useful with an inline `*>`).
  - `cobol-lens-disable [rules...]` suppresses from that point onward.
  - `cobol-lens-enable [rules...]` re-enables from that point onward.
  With no rule ids the directive applies to ALL rules. A `--` separator introduces an optional free-text reason that is ignored. Example: `      * cobol-lens-disable-next-line no-goto -- legacy jump`.
- Two new Quick Fixes on every COBOL Lens diagnostic: "Suppress '<rule>' on this line" (inserts a `cobol-lens-disable-next-line` comment above the flagged line) and "Suppress '<rule>' in the entire file" (inserts a `cobol-lens-disable` comment at the top of the file).
- New setting `cobolLens.linter.suppressions.enabled` (default `true`) to turn the inline suppression comments and the related Quick Fixes on or off.

## [1.6.0] - 2026-06-25

### Changed
- Double-clicking a COBOL identifier now selects the whole hyphenated name (e.g. `EX-VAL-CAMPO-DECOD`) instead of stopping at a single segment like `CAMPO`. This is achieved by removing the hyphen `-` from `editor.wordSeparators` for the `cobol` language (set as a default in the extension), so word selection, Ctrl+F "find selection" and double-click highlight treat hyphenated COBOL names as a single word.

## [1.5.4] - 2026-06-24

### Fixed
- `empty-paragraph`: paragraphs that contain only `EXIT`/`CONTINUE` are no longer flagged when they are the target of a `PERFORM ... THRU <name>` (or `THROUGH`), since such a paragraph is the intentional terminator of a perform range. The name-based exclusion now also covers the common `EX-` prefix convention (in addition to the `-EX`, `-EXIT`, `-FINE`, `-END`, `-X` suffixes). This makes the rule less aggressive on legacy code that uses THRU ranges.

## [1.5.3] - 2026-06-24

### Added
- New command `COBOL Lens: Toggle Comment` (default keybinding `Ctrl+K Ctrl+/`, the `oem_2` key, which on an Italian keyboard is the u-grave key, in the COBOL editor) that comments/uncomments the selected lines (or the cursor line). In fixed format it sets/clears the `*` in column 7; in variable/free format it adds/removes the inline `*>` comment. If every non-blank target line is already commented it uncomments, otherwise it comments. Works on multi-line selections.
- New commands `COBOL Lens: Format Document` and `COBOL Lens: Format Selection`, available from the editor context menu and the Command Palette (the titles include the `COBOL Lens:` prefix so they are easy to tell apart from the built-in ones in the right-click menu). Unlike VS Code's built-in "Format Document With...", "Format Selection" formats only the selected lines. These dedicated commands also run regardless of the `cobolLens.format.enabled` toggle (they are explicit user actions), while still applying only to fixed-format source.

### Changed
- Formatter: in an `EVALUATE`, the `WHEN` branches are now aligned to the same column as `EVALUATE` (instead of being indented one level under it); the statements inside each `WHEN` branch are indented 3 spaces. `END-EVALUATE` stays aligned with `EVALUATE`.
- Linter rule `no-goto` is now a `warning` instead of an `error`, and its message is now advisory: it suggests avoiding `GO TO` (which makes the control flow harder to follow and maintain) in favor of `PERFORM` and `IF`/`EVALUATE`, rather than stating it is forbidden. This avoids flooding legacy programs (where `GO TO` is common) with blocking errors.
- Linter rule `empty-paragraph`: exit-only paragraphs are now recognized by more naming conventions. In addition to `-EX`, names ending in `-EXIT`, `-FINE`, `-END` or `-X` that contain only `EXIT`/`CONTINUE` are no longer flagged, since they are intentional exit paragraphs.

### Fixed
- `undefined-variable`: index names declared in an `OCCURS ... INDEXED BY` clause are no longer reported as undefined. Both the single-index form and multiple indexes (`INDEXED BY IDX-1 IDX-2`) are recognized, whether the clause is on the same line as the level item or on a continuation line. The same index names are now also indexed by the parser, so Go to Definition, hover, Find All References and Rename work on them.
- `chars-after-period`: a paragraph header followed by a statement on the same line (the common `EX-ELABORA. EXIT.` idiom) is no longer flagged. The period that closes the paragraph name is not a sentence terminator, so the statement after it is valid; genuine spurious content after a real sentence-terminating period is still reported.

## [1.5.2] - 2026-06-24

### Changed
- Linter rule `uppercase` (COBOL code must be uppercase) is now disabled by default (`cobolLens.linter.rules.uppercase.enabled` default changed from `true` to `false`). Enable it explicitly if you want the uppercase check.

## [1.5.1] - 2026-06-24

### Changed
- Syntax highlighting: compiler directives (`$SET ...`, `>>` free-format directives) are now colored blue instead of purple. The TextMate scope changed from `keyword.control.directive.cobol` to `keyword.other.directive.cobol` so default dark themes render them blue.

### Fixed
- Syntax highlighting: the `FD` file description indicator is now colored like a keyword (purple) instead of as a plain identifier, consistent with the `SD`/`RD`/`CD` indicators which were already highlighted. A dedicated `file-description` grammar rule now covers all four level indicators (`FD`, `SD`, `RD`, `CD`).

## [1.5.0] - 2026-06-23

### Added
- Getting Started walkthrough. On first install (and from `Help > Welcome`) the extension now shows a "Get Started with COBOL Lens" walkthrough with a guided overview of the main features: why it is standalone (no compiler, no language server, no network), symbol and copybook navigation (including nested `COPY ... REPLACING`), the byte layout tools computed without a compiler (hover size, inlay hints, Record Layout panel), the 40-rule real-time linter with Quick Fixes, the IF/ELSE/END-IF block visualization with scope bars, code completion and snippets, and how to configure copybook folders and source format. The walkthrough is purely declarative and the layout step links straight to the `COBOL Lens: Show Record Layout` command. The walkthrough opens automatically only once, the very first time the extension is installed (it is opened to the side, without stealing focus, and never shown again); this one-time auto-open can be disabled with the new setting `cobolLens.showWelcomeOnStartup` (default `true`).

## [1.4.0] - 2026-06-23

### Added
- Syntax highlighting tailored for the Micro Focus / Rocket COBOL dialect. The extension now ships its own TextMate grammar so colors work standalone, without requiring any other COBOL extension. Coverage includes: DIVISION/SECTION headers, paragraph and section names, data level numbers (01-49, 66, 77, 78, 88), PICTURE strings (including edited and `S9(n)V9(n)` forms), USAGE types (`COMP`/`COMP-1..5`/`COMP-X`/`BINARY`/`PACKED-DECIMAL`/`POINTER`/`NATIONAL`...), statements/verbs, control flow and all `END-*` scope terminators, conditional operators, data/environment clauses, intrinsic `FUNCTION` calls, figurative constants, object-oriented headers (`CLASS-ID`/`METHOD-ID`...), `COPY`/`REPLACING`, embedded `EXEC SQL`/`EXEC CICS`/`EXEC DLI` blocks, compiler directives (`$SET`, `>>`), fixed-format comments (column 7) and debug lines (`D` in column 7), inline `*>` comments, the identification area (columns 73+ rendered as comment), numeric and string literals (including `X"..."`/`N"..."` and doubled-quote escapes). A broad reserved-word list colors the long tail of MF/Rocket keywords.
- New setting `cobolLens.syntaxHighlighting.enabled` (default `true`) to enable/disable an additional semantic coloring layer that highlights variables, paragraphs/sections and copybooks using the extension's symbol index. The base TextMate highlighting always stays active; the linter and navigation features are unaffected by this toggle.
- Quick Fixes (light bulb / Code Actions) for selected linter diagnostics. Most fixes only add text or normalize case (`end-structure` inserts the matching `END-IF`/`END-PERFORM`/`END-EVALUATE`/`END-CALL`... on its own line, aligned to the opening statement, moving the closing period after it; `missing-period` adds the trailing period; `uppercase` converts the code to UPPERCASE while preserving string literals; `missing-stop-run` appends a `GOBACK.` line; `missing-level` inserts a level number inferred from the previous data item; `missing-file-status` adds a `STATUS FS-<file>` clause to the `SELECT` sentence (on its own line, before the period; the status variable is named after the file and must then be defined in WORKING-STORAGE)). A few column-alignment fixes realign a single keyword by adjusting whitespace only, without deleting content: `pic-alignment` moves `PIC` to column 45, `move-to-alignment` moves the `TO` of a `MOVE` to column 45, `select-col12` realigns `SELECT` to column 12, and `assign-col29` realigns the `ASSIGN`/`ORGANIZATION`/`ACCESS`/`STATUS`/`RECORD KEY` clause to column 29. Controlled by the new setting `cobolLens.codeActions.enabled` (default `true`).
- Symbol rename (`F2`) for variables, paragraphs and sections. All whole-word occurrences in the current program are renamed at once, skipping comments and string literals; the new name is validated as a COBOL identifier (letters/digits/hyphens, max 30 chars, not a reserved word). By default symbols defined in a copybook are not renamed inside the (shared) copybook file; enable `cobolLens.rename.includeCopybooks` to also rename them there. Controlled by the new setting `cobolLens.rename.enabled` (default `true`).
- Code completion (IntelliSense) for COBOL symbols and keywords, built on the extension's symbol index. It suggests data item (variable) names and paragraph/section names defined in the current program, plus a curated list of common COBOL verbs and keywords. After `PERFORM`, `GO TO`, `THRU`/`THROUGH` only paragraph and section names are offered (variables and keywords are suppressed) and they are sorted first. The existing `COPY` copybook completion is preserved. Controlled by the new setting `cobolLens.completion.enabled` (default `true`), with per-category sub-toggles `cobolLens.completion.variables`, `cobolLens.completion.paragraphs` and `cobolLens.completion.keywords` (all default `true`).
- Workspace symbol search (`Ctrl+T`, "Go to Symbol in Workspace"). Variables, paragraphs and sections defined across every COBOL file in the workspace can be searched with fuzzy matching; selecting a result jumps to its definition. Only symbols defined in each file are listed (copybook expansions are not duplicated). Controlled by the new setting `cobolLens.workspaceSymbols.enabled` (default `true`).
- CodeLens reference counts above each paragraph and section definition (e.g. `3 references`). Clicking the lens opens the references peek with every `PERFORM`/`GO TO` usage in the file. Off by default; enable with the new setting `cobolLens.codeLens.enabled`.
- Call Hierarchy (`Show Call Hierarchy`) for paragraphs and sections. Incoming calls list the paragraphs that `PERFORM`/`GO TO` the selected one; outgoing calls list the paragraphs it executes. `PERFORM ... THRU/THROUGH` ranges are resolved to both endpoints. A dedicated keybinding `Ctrl+Alt+H` (active only in the COBOL editor) is provided, since the default `Shift+Alt+H` can collide with other commands. Controlled by the new setting `cobolLens.callHierarchy.enabled` (default `true`).
- Fixed-format formatter (`Format Document` / `Format Selection`). It reindents the code area (col 8-72) while preserving the sequence area (col 1-6) and the identification area (col 73+), and leaves comments and continuation lines untouched. Rules: DIVISION/SECTION headers, paragraphs and `01`/`77` levels (plus `FD`/`SD` and the standard IDENTIFICATION/ENVIRONMENT paragraphs) go to Area A (col 8); data items are indented hierarchically by 3 spaces per nesting level (`88` items as children of the current item); exactly one space separates a level number from its name (and `FD`/`SD` from the file name); the `PIC` clause is aligned to column 45 (for `88` items the `VALUE` clause is aligned to the column of the parent item's `VALUE` when present, otherwise to column 45, so condition values line up under the value they qualify), with following clauses kept one space apart; PROCEDURE statements start at col 12 and nested blocks (`IF`/`ELSE`, `EVALUATE`/`WHEN`, inline `PERFORM`) indent 3 spaces per level, the `TO` keyword of `MOVE`/`SET`/`ADD` is aligned to column 45, the continuation of a `PERFORM VARYING` condition aligns `UNTIL` under the third letter of `VARYING` and right-aligns the following `AND`/`OR` connectors to the end of `VARYING`, and the sentence-terminating period closes all open scopes; all trailing spaces are trimmed. When aligning to column 45 would push a line past column 72, the gap before `PIC`/`TO`/`VALUE` is reduced progressively (down to a single space) without dropping any content; a data item whose clauses still do not fit is split across lines aligned to column 45. Only runs when the source format is `fixed`. Off by default; enable with the new setting `cobolLens.format.enabled`.
- Inlay hints showing the byte position and size of each DATA DIVISION field. At the end of every data definition line the extension renders the field's 1-based byte position (from the start of its `01` record) and its size in bytes, computed from the PICTURE, USAGE (`DISPLAY`/`COMP`/`COMP-3`/`COMP-1`/`COMP-2`/`INDEX`/`POINTER`...) and `OCCURS`; `REDEFINES` items overlay the redefined area, groups report their total area size, and `88`/`66` levels (no storage) are skipped. Hints reflect the `cobolLens.language` setting. On by default; disable with the new setting `cobolLens.inlayHints.enabled`. The new setting `cobolLens.inlayHints.display` chooses where the information is shown: `inline` (default) as inlay hints at the end of the line, or `hover` to show it only inside the symbol hover tooltip (less intrusive).
- Record layout view. The command `COBOL Lens: Show Record Layout` (also in the editor context menu) opens a side panel listing every DATA DIVISION record of the active file with, for each field, its level, name (indented by nesting depth), 1-based start and end byte offsets, size in bytes and notes (group, `REDEFINES`, `OCCURS n`, from copybook, no storage). Each `01`/`77` record restarts at offset 1 and shows its total size. Off by default; enable with the new setting `cobolLens.recordLayout.enabled`.
- Code snippets for common COBOL constructs, offered as completion items: block statements (`if`, `ifelse`, `evaluate`, `performuntil`, `performvarying`, `performtimes`, `performthru`, `call`, `read`, `string`, `unstring`), DATA DIVISION items with parametric PICTURE clauses (`group`, `picx`, `pic9`, `pics9`, `comp3`, `comp`, `value`, `level88`, `occurs`) and structure/skeleton helpers (`select`, `fd`, `paragraph`, `program`). Each snippet uses tab stops and placeholders. On by default; disable with the new setting `cobolLens.snippets.enabled`.

### Fixed
- `chars-after-period`: no longer reports false positives on periods that are not statement terminators. A period is now treated as a terminator only when followed by a space or end of line, so the decimal point in numeric literals (`VALUE 12.50.`) and the editing period inside PICTURE strings (`PIC ZZ,ZZ9.99-.`) are ignored. The `SOURCE-COMPUTER.`/`OBJECT-COMPUTER.` paragraph headers of the CONFIGURATION SECTION (e.g. `SOURCE-COMPUTER. IBM-370.`) are also no longer flagged.

### Notes
- The grammar uses a dedicated scope name (`source.cobol.lens`) to avoid the TextMate scope-mapping collision warning when another COBOL extension (which uses `source.cobol`) is also installed.

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
