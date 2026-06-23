## See the byte layout -- without a compiler

Most tools need to compile your program to tell you where a field sits in the record. COBOL Lens computes it directly from `PIC`, `USAGE` and `OCCURS`:

- **Hover** a field to see its size in bytes (groups show the total area size).
- **Inlay hints** show the byte position and size at the end of each DATA DIVISION line.
- The **Record Layout** panel lists every record with the start/end offset and size of each field.

`REDEFINES` items overlay the redefined area and `88`/`66` levels (no storage) are skipped, so the numbers match what the compiler would produce.

> Open a `.CBL` file and run **COBOL Lens: Show Record Layout** from the Command Palette or the editor context menu.
