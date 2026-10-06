## Navigate symbols and copybooks

COBOL Lens builds a complete symbol index by **recursively resolving COPY statements**, including `COPY ... REPLACING ==OLD== BY ==NEW==`. That means navigation keeps working even when a symbol is defined several copybooks deep.

| Action | Shortcut |
|--------|----------|
| Go to Definition | `F12` / `Ctrl+Click` |
| Go to Called Program | `F12` / `Ctrl+Click` on `CALL 'PROGNAME'` |
| Peek Definition | `Alt+F12` |
| Find All References | `Shift+F12` |
| Rename Symbol | `F2` |
| Go to Symbol in Workspace | `Ctrl+T` |
| Call Hierarchy | `Ctrl+Alt+H` |

Jump straight into a copybook from a `COPY` statement, to the source of a called program from a `CALL`, or to any variable, paragraph or section -- no compiler, no indexing server.

More help while you read: put the cursor on a symbol to **highlight every occurrence** in the file, **hover** an `88` item to see its parent field and `VALUE`s, and get **parameter hints** when you type `FUNCTION name(`.
