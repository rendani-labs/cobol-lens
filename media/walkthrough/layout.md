## See the byte layout -- without a compiler

Most tools need to compile your program to tell you where a field sits in the record. COBOL Lens computes it directly from `PIC`, `USAGE` and `OCCURS`:

- **Hover** a field to see its size in bytes (groups show the total area size).
- **Inlay hints** show the byte position and size at the end of each DATA DIVISION line.
- The **Record Layout** panel lists every record with the start/end offset and size of each field.

`REDEFINES` items overlay the redefined area and `88`/`66` levels (no storage) are skipped, so the numbers match what the compiler would produce. `OCCURS ... DEPENDING ON` tables and `REDEFINES` overlaps are highlighted in the Record Layout panel.

Binary items (`COMP`, `COMP-4`, `BINARY`, `COMP-5`) follow your **`cobolLens.binaryStorage`** setting (see the first step), and `COMP-X`, `COMP-3`, `COMP-6`, floats, pointers and national items are sized too. If the inlay hints get in the way, set `cobolLens.inlayHints.display` to `hover`.

> Enable `cobolLens.recordLayout.enabled`, open a `.CBL` file and run **COBOL Lens: Show Record Layout** from the Command Palette or the editor context menu.
