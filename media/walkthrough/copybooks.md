## Master your copybooks

Copybooks are at the heart of COBOL Lens -- and three features let you see through them without a compiler:

- **Copybook Dependencies** -- the "COBOL Copybook Dependencies" tree in the Explorer shows the nested `COPY` graph of the active file. Unresolved copybooks are flagged "not found" and recursive includes are marked "recursion" (without looping). Click any node to open it.
- **Expand Copybooks (Preview)** -- open a read-only view with every `COPY` expanded inline, including nested copybooks and `COPY ... REPLACING ==OLD== BY ==NEW==` (pseudo-text substitution). Perfect for reviewing the final record layout that the compiler would actually see.
- **Copybooks that know their program** -- open a copybook from a program (`F12` / `Ctrl+Click` on the `COPY` name, the "Open copybook" hover link, or the dependency tree) and its fields are checked against that program: `unused-variable` sees the usage in the program, including fields renamed by `COPY ... REPLACING`. A copybook opened by hand has no program context, so the rules that need the whole program (unused/undefined variables and paragraphs) stay quiet instead of flooding you with warnings.

These features resolve copybooks through the same folders and extensions used everywhere else, so what you see matches your navigation.

> Open a `.CBL` file and run **COBOL Lens: Expand Copybooks (Preview)** from the Command Palette or the editor context menu.
