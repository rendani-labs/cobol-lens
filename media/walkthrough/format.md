## Format your code

COBOL Lens ships a **fixed-format formatter**, on by default (`cobolLens.format.enabled`). Run **Format Document** (`Shift+Alt+F`) or **Format Selection**:

- Code goes to the right area (A/B) with a 3-space indentation hierarchy (`cobolLens.format.indentStep`).
- `IF`, `EVALUATE`/`WHEN`, `SEARCH`/`AT END` and `PERFORM ... THRU` are nested and aligned.
- `PIC`, `VALUE` and the `TO` of `MOVE`/`ADD` line up on column 45 (`cobolLens.format.pictureColumn`).
- Lines that would pass column 72 are wrapped, and long literals are continued correctly.
- Optional, off by default: separator lines before each division/section/paragraph (`cobolLens.format.sectionSeparators`) and blank lines between statements (`cobolLens.format.blankLines`).

Also from the editor context menu:

- **COBOL Lens: Trim Trailing Whitespace** -- removes trailing spaces, but leaves alone a literal continued on the next line.
- **COBOL Lens: Toggle Comment** (`Ctrl+K Ctrl+/`) -- `*` in column 7 for fixed format, `*>` for variable/free.
