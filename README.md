# COBOL Lens

A lightweight VS Code extension for navigating COBOL copybooks and symbols -- no compiler or language server required.

## Features

### Navigation & IntelliSense

| Feature | Shortcut | Description |
|---------|----------|-------------|
| **Go to Definition** | `F12` / `Ctrl+Click` | Jump to copybook files, variable definitions, paragraphs, and sections |
| **Peek Definition** | `Alt+F12` | Inline preview of definitions without leaving your current file |
| **Find All References** | `Shift+F12` | Locate every usage of a variable, paragraph, or section |
| **Hover Information** | Mouse hover | See type, level, source file, definition line, and the size in bytes (for groups, the total area size = sum of sub-fields) for any symbol |
| **Copybook Autocomplete** | Type `COPY ` | Auto-suggest copybook names from configured folders |
| **Code Folding** | `Ctrl+Shift+[` | Collapse DIVISIONs, SECTIONs, and paragraphs |
| **Outline View** | Sidebar | Browse the full structure of your program: variables, paragraphs, sections |
| **Missing Copybook Warning** | Automatic | Flags unresolved COPY statements in the Problems panel |
| **COPY ... REPLACING** | Automatic | Full support for `==OLD== BY ==NEW==` replacements |

### IF Block Visualization

When the cursor is on an `IF`, `ELSE`, or `END-IF` line, colored **keyword borders** highlight the matching block. **Scope bars** run along the left margin for every nesting level (up to 9 levels), making it easy to track complex nested conditions at a glance.

Can be controlled via `cobolLens.ifBlockHighlight.enabled` and `cobolLens.ifBlockHighlight.scopeBars`.

### Integrated Linter

A built-in COBOL linter with **40 configurable rules** that checks your code in real-time as you type (or on save). Every rule can be individually enabled/disabled and its severity set to `error`, `warning`, or `info`.

Categories of rules:

- **Structure** -- DIVISION order, END-IF/END-PERFORM matching, orphan scope delimiters
- **Formatting** -- column 72 limit, PIC alignment, level spacing, uppercase enforcement
- **Code quality** -- undefined/unused variables, undefined/unused paragraphs, duplicate definitions
- **Best practices** -- no GOTO, no AT END, no ELSE IF, REDEFINES size check, missing STOP RUN
- **File handling** -- missing FILE STATUS, COPY resolution, PERFORM THRU order

See [Linter Rules](#linter-rules) below for the full list.

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
| `cobolLens.linter.enabled` | `true` | Enable/disable the integrated linter |
| `cobolLens.linter.onType` | `true` | Lint in real-time while typing (if false, only on save) |
| `cobolLens.linter.delay` | `500` | Delay in ms before linting after a change (100-5000) |

## Linter Rules

Each rule has `.enabled` (boolean) and `.severity` (`"error"`, `"warning"`, or `"info"`) settings under `cobolLens.linter.rules.<rule-name>`. The **Default** column shows whether the rule is enabled out of the box (`on`) or disabled and opt-in (`off`).

| Rule | Default | Severity | Description |
|------|---------|----------|-------------|
| `col72` | on | error | Code must not exceed column 72 |
| `no-goto` | on | error | No GOTO -- use PERFORM and IF instead |
| `no-at-end` | off | error | No AT END / NOT AT END -- use FILE STATUS with EVALUATE |
| `no-level-77-78` | off | error | No level 77/78 in WORKING-STORAGE |
| `uppercase` | on | warning | COBOL code must be uppercase |
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
| `empty-paragraph` | on | warning | Flags paragraphs containing only EXIT/CONTINUE |
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

## Compatibility

- **VS Code** 1.75.0 or later
- **COBOL dialect**: Micro Focus / Rocket COBOL (fixed and variable format)
- **Platform**: Windows, Linux, macOS
- **Dependencies**: None

## Known Limitations

- Fixed and variable source formats are fully supported. Free-format COBOL (`$SET SOURCEFORMAT(FREE)`) is recognized by the linter but not by navigation: symbols, hover, and Go to Definition assume the fixed/variable column layout (sequence area in columns 1-6, indicator in column 7, code from column 8)
- The linter is not a compiler -- it catches common issues but does not validate full COBOL semantics
- Copybook resolution requires the files to be present locally in the workspace

## License

MIT
