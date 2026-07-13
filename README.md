# COBOL Lens

[![Version](https://img.shields.io/visual-studio-marketplace/v/rendani-labs.cobol-lens?label=Marketplace&color=1e7e34)](https://marketplace.visualstudio.com/items?itemName=rendani-labs.cobol-lens)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/rendani-labs.cobol-lens?label=Installs)](https://marketplace.visualstudio.com/items?itemName=rendani-labs.cobol-lens)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/rendani-labs.cobol-lens?label=Downloads)](https://marketplace.visualstudio.com/items?itemName=rendani-labs.cobol-lens)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/rendani-labs.cobol-lens?label=Rating)](https://marketplace.visualstudio.com/items?itemName=rendani-labs.cobol-lens&ssr=false#review-details)
[![Issues](https://img.shields.io/github/issues/rendani-labs/cobol-lens?label=Issues)](https://github.com/rendani-labs/cobol-lens/issues)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A lightweight VS Code extension for navigating COBOL copybooks and symbols -- no compiler or language server required.

This extension is tailored for the **Micro Focus / Rocket COBOL** dialect (Enterprise Developer / Visual COBOL).

## Features

### Getting Started

On first install (and any time from `Help > Welcome`) a **Getting Started walkthrough** gives a guided tour of the main features and highlights what COBOL Lens does without a compiler or language server. It opens automatically only once on the very first install (to the side, without stealing focus); you can disable this with `cobolLens.showWelcomeOnStartup`. You can reopen it from the Command Palette with `Welcome: Open Walkthrough...`.

### Syntax Highlighting

Built-in syntax highlighting for the Micro Focus / Rocket COBOL dialect, styled similarly to the Rocket COBOL extension. It works standalone (no other COBOL extension required) and covers DIVISION/SECTION headers, level numbers, PICTURE clauses, USAGE types, statements and verbs, conditionals, figurative constants, intrinsic functions, `COPY`/`REPLACING`, embedded `EXEC SQL`/`EXEC CICS` blocks, compiler directives, fixed-format (column 7) and inline `*>` comments, and numeric/string literals.

An optional **semantic coloring** layer additionally highlights variables, paragraphs/sections and copybooks using the extension's own symbol index. It can be toggled with `cobolLens.syntaxHighlighting.enabled` (default `on`); turning it off keeps the base highlighting, linter and navigation fully active.

### Navigation & IntelliSense

| Feature | Shortcut | Description |
|---------|----------|-------------|
| **Go to Definition** | `F12` / `Ctrl+Click` | Jump to copybook files, variable definitions, paragraphs, and sections |
| **Peek Definition** | `Alt+F12` | Inline preview of definitions without leaving your current file |
| **Find All References** | `Shift+F12` | Locate every usage of a variable, paragraph, or section |
| **Highlight Occurrences** | Cursor on a symbol | Automatically highlight every occurrence of the symbol under the cursor in the current file (the definition is marked as a write) |
| **Signature Help** | Type `FUNCTION name(` | Parameter hints for common COBOL intrinsic functions, with the current argument highlighted (follows commas and nested calls) |
| **Rename Symbol** | `F2` | Rename a variable, paragraph, or section across the whole program (and optionally inside copybooks) |
| **Hover Information** | Mouse hover | See type, level, source file, definition line, and the size in bytes (for groups, the total area size = sum of sub-fields) for any symbol |
| **Copybook Autocomplete** | Type `COPY ` | Auto-suggest copybook names from configured folders |
| **Code Completion** | Type / `Ctrl+Space` | Suggest variables, paragraphs/sections (prioritized after `PERFORM`/`GO TO`) and common COBOL keywords |
| **Go to Symbol in Workspace** | `Ctrl+T` | Fuzzy-search variables, paragraphs and sections across all COBOL files in the workspace |
| **Reference CodeLens** | Above paragraphs | Show how many times a paragraph or section is used; click to peek the references (off by default) |
| **Call Hierarchy** | `Ctrl+Alt+H` | Show incoming/outgoing `PERFORM` calls for a paragraph or section |
| **Format Document** | `Shift+Alt+F` | Reindent fixed-format code (Area A/B, 3-space hierarchy, `EVALUATE`/`WHEN` aligned, PIC/TO/VALUE aligned to col 45, col 72 overflow handling, trailing trim); also Format Selection (off by default) |
| **Format Document / Selection (commands)** | Context menu / Command Palette | `COBOL Lens: Format Document` and `COBOL Lens: Format Selection` run the formatter explicitly (Format Selection touches only the selected lines), regardless of the `cobolLens.format.enabled` toggle |
| **Toggle COBOL Comment** | `Ctrl+K Ctrl+/` (`oem_2` key; on an Italian keyboard this key is the one labelled with the u-grave accent) | Comment/uncomment the selected lines (or cursor line): `*` in column 7 for fixed format, inline `*>` for variable/free |
| **Field Inlay Hints** | Automatic | Show the byte position and size of each DATA DIVISION field at end of line (computed from PIC/USAGE/OCCURS; on by default) |
| **Record Layout** | Context menu / Command Palette | Show a panel with the byte start/end offset and size of every field in each DATA DIVISION record (off by default) |
| **Code Snippets** | IntelliSense | Templates for IF/EVALUATE/PERFORM/CALL, parametric PIC clauses, FD/SELECT and a full program skeleton (on by default) |
| **Code Folding** | `Ctrl+Shift+[` | Collapse DIVISIONs, SECTIONs, and paragraphs |
| **Outline View** | Sidebar | Browse the full structure of your program: variables, paragraphs, sections |
| **Missing Copybook Warning** | Automatic | Flags unresolved COPY statements in the Problems panel |
| **COPY ... REPLACING** | Automatic | Full support for `==OLD== BY ==NEW==` replacements |

### IF Block Visualization

When the cursor is on an `IF`, `ELSE`, or `END-IF` line, colored **keyword borders** highlight the matching block. **Scope bars** run along the left margin for every nesting level (up to 9 levels), making it easy to track complex nested conditions at a glance.

Can be controlled via `cobolLens.ifBlockHighlight.enabled` and `cobolLens.ifBlockHighlight.scopeBars`.

### Integrated Linter

A built-in COBOL linter with **47 configurable rules** that checks your code in real-time as you type (or on save). Every rule can be individually enabled/disabled and its severity set to `error`, `warning`, or `info`.

Categories of rules:

- **Structure** -- DIVISION order, END-IF/END-PERFORM matching, orphan scope delimiters
- **Formatting** -- column 72 limit, PIC alignment, level spacing, uppercase enforcement
- **Code quality** -- undefined/unused variables, undefined/unused paragraphs, duplicate definitions
- **Best practices** -- no GOTO, no AT END, no ELSE IF, REDEFINES size check, missing STOP RUN
- **File handling** -- missing FILE STATUS, COPY resolution, PERFORM THRU order

See [Linter Rules](#linter-rules) below for the full list.

### Quick Fixes

When the linter reports certain issues, a **light bulb** (Code Action) offers a one-click fix. Most fixes only add text or normalize case; a few realign a single keyword to its standard column by adjusting whitespace only (no content is deleted):

| Diagnostic | Quick Fix |
|------------|-----------|
| `end-structure` | Insert the matching `END-IF` / `END-PERFORM` / `END-EVALUATE` / `END-CALL`... on its own line, aligned to the opening statement (the closing period moves after it) |
| `missing-period` | Add the trailing period |
| `uppercase` | Convert the code to UPPERCASE (string literals are preserved) |
| `missing-stop-run` | Append a `GOBACK.` line |
| `missing-level` | Insert a level number (inferred from the previous data item) |
| `missing-file-status` | Add a `STATUS FS-<file>` clause to the `SELECT` (the variable is named after the file and must then be defined in WORKING-STORAGE) |
| `pic-alignment` | Realign the `PIC` keyword to column 45 (adjusts the spaces before it) |
| `move-to-alignment` | Realign the `TO` of a `MOVE` to column 45 (adjusts the spaces before it) |
| `select-col12` | Realign `SELECT` to column 12 (adjusts the leading indentation) |
| `assign-col29` | Realign the clause (`ASSIGN`/`ORGANIZATION`/`ACCESS`/`STATUS`/`RECORD KEY`) to column 29 |

Can be turned off with `cobolLens.codeActions.enabled` (default `on`).

### Code Completion

As you type (or with `Ctrl+Space`), IntelliSense suggests symbols from the current program and common COBOL keywords:

- **Variables** -- data item names defined in WORKING-STORAGE, LINKAGE, FILE SECTION, etc.
- **Paragraphs and sections** -- after `PERFORM`, `GO TO`, `THRU`/`THROUGH` only these are offered (and sorted first)
- **Keywords** -- a curated list of common COBOL verbs and clauses (`MOVE`, `EVALUATE`, `END-IF`, `PIC`, `OCCURS`...)

The existing `COPY ` copybook completion is unaffected. Controlled by `cobolLens.completion.enabled` (default `on`), with per-category toggles `cobolLens.completion.variables`, `cobolLens.completion.paragraphs` and `cobolLens.completion.keywords`.

## Supported File Types

- `.CBL`, `.cbl` -- COBOL batch programs
- `.clt`, `.CLT` -- COBOL online programs
- Copybooks with any extension (configurable) or no extension at all

## How It Works

The extension parses your COBOL source files and recursively resolves `COPY` statements to build a complete symbol index. This includes:

- **Variables** -- All levels (01-49, 66, 77, 88) from both the program and included copybooks
- **Paragraphs** -- Procedure names in area A
- **Sections** -- Named sections in the PROCEDURE DIVISION
- **COPY ... REPLACING** -- Symbols from copybooks are renamed according to replacement pairs

No compilation is needed. No external tools. No network access. Everything runs locally in your editor.

## Installation

### From the Marketplace

Search for **COBOL Lens** in the Extensions view (`Ctrl+Shift+X`) and click Install.

### From VSIX file

1. Get the `.vsix` file
2. In VS Code: `Ctrl+Shift+P` > **Extensions: Install from VSIX...** > select the file
3. Reload VS Code

## Configuration

Add these settings to your workspace `.vscode/settings.json`:

```json
{
  "cobolLens.copyFolders": ["Copy"],
  "cobolLens.copyExtensions": ["", ".cpy", ".CPY", ".COPY", ".copy"],
  "cobolLens.ignoredCopybooks": ["DFHBMSCA", "DFHAID"]
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `cobolLens.copyFolders` | `["Copy", "Copy_DR", "Copy_Prod"]` | Folders to search for copybooks (relative to workspace root) |
| `cobolLens.copyExtensions` | `["", ".cpy", ".CPY", ".COPY", ".copy"]` | File extensions to try when resolving copybook names |
| `cobolLens.ignoredCopybooks` | `["DFHBMSCA", "DFHAID"]` | Copybooks excluded from unresolved COPY diagnostics |
| `cobolLens.language` | `"auto"` | Language of linter diagnostic messages: `auto` (follow VS Code), `it`, or `en` |
| `cobolLens.ifBlockHighlight.enabled` | `true` | Highlight IF/ELSE/END-IF blocks with per-nesting-level colors |
| `cobolLens.ifBlockHighlight.scopeBars` | `true` | Show colored side bars to visualize the scope of each IF block |
| `cobolLens.codeActions.enabled` | `true` | Enable Quick Fixes (light bulb) for linter diagnostics |
| `cobolLens.rename.enabled` | `true` | Enable symbol rename (F2) for variables, paragraphs and sections |
| `cobolLens.rename.includeCopybooks` | `false` | Also rename inside copybook files (shared across programs -- use with care) |
| `cobolLens.completion.enabled` | `true` | Enable code completion (IntelliSense) for COBOL symbols and keywords |
| `cobolLens.completion.variables` | `true` | Suggest variable (data item) names from the current program |
| `cobolLens.completion.paragraphs` | `true` | Suggest paragraph and section names (prioritized after PERFORM / GO TO) |
| `cobolLens.completion.keywords` | `true` | Suggest common COBOL verbs and keywords |
| `cobolLens.workspaceSymbols.enabled` | `true` | Enable Go to Symbol in Workspace (Ctrl+T) across all COBOL files |
| `cobolLens.codeLens.enabled` | `false` | Show reference-count CodeLens above paragraphs and sections |
| `cobolLens.callHierarchy.enabled` | `true` | Enable Call Hierarchy (PERFORM/GO TO) for paragraphs and sections |
| `cobolLens.documentHighlight.enabled` | `true` | Highlight every occurrence of the symbol under the cursor in the current file |
| `cobolLens.signatureHelp.enabled` | `true` | Show parameter hints for COBOL intrinsic functions while typing FUNCTION calls |
| `cobolLens.format.enabled` | `false` | Enable the fixed-format formatter (Format Document / Format Selection) |
| `cobolLens.inlayHints.enabled` | `true` | Show inlay hints with byte position and size of DATA DIVISION fields |
| `cobolLens.inlayHints.display` | `inline` | Where to show field position/size: `inline` (inlay hints) or `hover` (symbol tooltip, less intrusive) |
| `cobolLens.recordLayout.enabled` | `false` | Enable the "Show Record Layout" command (byte offsets/size of each record field) |
| `cobolLens.snippets.enabled` | `true` | Provide COBOL code snippets (IF/EVALUATE/PERFORM, parametric PIC, program skeleton) |
| `cobolLens.linter.enabled` | `true` | Enable/disable the integrated linter |
| `cobolLens.linter.onType` | `true` | Lint in real-time while typing (if false, only on save) |
| `cobolLens.linter.delay` | `500` | Delay in ms before linting after a change (100-5000) |

## Linter Rules

Each rule has `.enabled` (boolean) and `.severity` (`"error"`, `"warning"`, or `"info"`) settings under `cobolLens.linter.rules.<rule-name>`. The **Default** column shows whether the rule is enabled out of the box (`on`) or disabled and opt-in (`off`).

| Rule | Default | Severity | Description |
|------|---------|----------|-------------|
| `col72` | on | error | Code must not exceed column 72 |
| `no-goto` | on | warning | Advises against GO TO -- prefer PERFORM and IF/EVALUATE for clearer control flow |
| `no-at-end` | off | error | No AT END / NOT AT END -- use FILE STATUS with EVALUATE |
| `no-level-77-78` | off | error | No level 77/78 in WORKING-STORAGE |
| `uppercase` | off | warning | COBOL code must be uppercase |
| `division-separator` | off | warning | A separator line is required before each DIVISION/SECTION |
| `pic-alignment` | off | warning | PIC clause must start at position 45 |
| `select-col12` | off | warning | SELECT in FILE-CONTROL must start at column 12 |
| `assign-col29` | off | warning | ASSIGN TO, ORGANIZATION, etc. must start at column 29 |
| `ws-levels` | off | warning | WORKING-STORAGE levels must be 01, 05, 10, 15... or 66, 88 |
| `paragraph-naming` | off | warning | Paragraphs must follow naming convention (I0001-/E0001-/F0001-/V0000-/S0000-) |
| `no-else-if` | off | warning | No ELSE IF -- nest IF inside ELSE instead |
| `move-to-alignment` | off | warning | In MOVE...TO, the word TO must start at position 45 |
| `ws-level-spacing` | off | warning | Exactly 1 space between level number and variable name |
| `end-structure` | on | warning | Every IF/PERFORM/EVALUATE must have its END- counterpart |
| `undefined-variable` | on | error | Variables used must be defined in program or copybooks |
| `undefined-paragraph` | on | error | Every PERFORM must reference a defined paragraph |
| `unused-paragraph` | on | warning | Flags paragraphs defined but never called |
| `unused-variable` | on | warning | Flags variables defined in WORKING-STORAGE but never used |
| `duplicate-variable` | on | error | No duplicate variable definitions |
| `missing-period` | on | error | Variable definitions must end with a period |
| `pic-missing` | on | error | Elementary variables must have a PIC clause |
| `mismatched-copy` | on | error | COPY statements must reference existing files |
| `perform-thru-order` | on | error | In PERFORM X THRU Y, Y must be defined after X |
| `section-order` | on | error | DIVISIONs must be in the mandatory order |
| `empty-paragraph` | on | warning | Flags paragraphs containing only EXIT/CONTINUE (exit paragraphs ending in -EX/-EXIT/-FINE/-END/-X, starting with EX-, or used as a PERFORM ... THRU target are excluded) |
| `consecutive-perform-spacing` | off | warning | A blank line is required between consecutive PERFORMs |
| `missing-file-status` | on | warning | Every SELECT must have a STATUS clause |
| `missing-stop-run` | on | warning | Program must contain STOP RUN or GOBACK |
| `and-or-if` | on | error | Flags spurious IF after AND/OR in compound conditions |
| `redefines-size` | on | error | REDEFINES must have the same size as the original item |
| `invalid-column-7` | on | error | Column 7 must contain only valid indicator characters |
| `unsubscripted-occurs` | on | error | Variables with OCCURS must be used with a subscript |
| `orphan-scope-delimiter` | on | error | END-IF/END-PERFORM/END-EVALUATE without opening statement |
| `variable-name-length` | on | error | Variable names must not exceed 30 characters (Micro Focus limit) |
| `missing-level` | on | error | Variable in DATA DIVISION declared without a level number |
| `chars-after-period` | on | error | Non-whitespace content after a statement period |
| `compute-multiline-asterisk` | on | warning | Multi-line COMPUTE where a line ends with `*` (breaks CICS precompiler) |
| `alphanumeric-in-compute` | on | error | Alphanumeric variable used in COMPUTE/ADD/SUBTRACT/MULTIPLY/DIVIDE |
| `move-alphanumeric-to-numeric` | on | error | Alphanumeric value (literal, figurative constant or alphanumeric variable) moved into a numeric variable; `FUNCTION NUMVAL` is excluded |
| `duplicate-paragraph` | on | error | Two paragraphs with the same name in the same section (makes PERFORM ambiguous) |
| `alter-statement` | on | warning | Use of ALTER (rewrites a GO TO target at runtime, hard to maintain) |
| `next-sentence` | on | warning | Use of NEXT SENTENCE (deprecated and fragile; use CONTINUE) |
| `evaluate-without-when-other` | on | warning | EVALUATE closed by END-EVALUATE without a WHEN OTHER default branch |
| `perform-varying-without-until` | on | warning | PERFORM VARYING without an UNTIL clause (risk of an infinite loop) |
| `level-88-without-parent` | on | error | Level 88 condition-name not subordinate to any parent data item |
| `move-truncation` | on | warning | MOVE into a destination with a smaller PIC (silent truncation); pure alphanumeric or numeric elementary items only |

## Compatibility

- **VS Code** 1.75.0 or later
- **COBOL dialect**: Micro Focus / Rocket COBOL (fixed and variable format)
- **Platform**: Windows, Linux, macOS
- **Dependencies**: None

## Known Limitations

- Fixed and variable source formats are fully supported. Free-format COBOL (`$SET SOURCEFORMAT(FREE)`) is recognized by the linter but not by navigation: symbols, hover, and Go to Definition assume the fixed/variable column layout (sequence area in columns 1-6, indicator in column 7, code from column 8)
- The linter is not a compiler -- it catches common issues but does not validate full COBOL semantics
- Copybook resolution requires the files to be present locally in the workspace

## Feedback and Community

This extension grows with feedback from real COBOL developers. Your input is welcome.

- **Found a bug?** Open a [bug report](https://github.com/rendani-labs/cobol-lens/issues/new?labels=bug) and include a minimal COBOL snippet, the expected vs actual behavior, and your source format (fixed/variable).
- **Have an idea or a new linter rule in mind?** Open a [feature request](https://github.com/rendani-labs/cobol-lens/issues/new?labels=enhancement).
- **Questions, tips, or general discussion?** Use [GitHub Discussions](https://github.com/rendani-labs/cobol-lens/discussions).
- **Enjoying the extension?** A [rating or review](https://marketplace.visualstudio.com/items?itemName=rendani-labs.cobol-lens&ssr=false#review-details) on the Marketplace helps others discover it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report issues effectively and propose changes.

## License

MIT
