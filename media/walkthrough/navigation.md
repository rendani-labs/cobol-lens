## Navigate symbols and copybooks

COBOL Lens builds a complete symbol index by **recursively resolving COPY statements**, including `COPY ... REPLACING ==OLD== BY ==NEW==`. That means navigation keeps working even when a symbol is defined several copybooks deep.

| Action | Shortcut |
|--------|----------|
| Go to Definition | `F12` / `Ctrl+Click` |
| Peek Definition | `Alt+F12` |
| Find All References | `Shift+F12` |
| Rename Symbol | `F2` |
| Go to Symbol in Workspace | `Ctrl+T` |
| Call Hierarchy | `Ctrl+Alt+H` |

Jump straight into a copybook from a `COPY` statement, or to any variable, paragraph or section -- no compiler, no indexing server.
