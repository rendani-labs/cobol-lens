## Master your copybooks

Copybooks are at the heart of COBOL Lens -- and two features let you see through them without a compiler:

- **Copybook Dependencies** -- the "COBOL Copybook Dependencies" tree in the Explorer shows the nested `COPY` graph of the active file. Unresolved copybooks are flagged "not found" and recursive includes are marked "recursion" (without looping). Click any node to open it.
- **Expand Copybooks (Preview)** -- open a read-only view with every `COPY` expanded inline, including nested copybooks and `COPY ... REPLACING ==OLD== BY ==NEW==` (pseudo-text substitution). Perfect for reviewing the final record layout that the compiler would actually see.

Both resolve copybooks through the same folders and extensions used everywhere else, so what you see matches your navigation.

> Open a `.CBL` file and run **COBOL Lens: Expand Copybooks (Preview)** from the Command Palette or the editor context menu.
