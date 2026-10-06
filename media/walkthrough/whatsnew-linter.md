## Fewer false alarms, more real catches

- **`COPY ... REPLACING` everywhere**: fields renamed by `REPLACING` (`:TAG:` placeholders, `LEADING` / `TRAILING`, several pairs in one clause, the same copybook included many times) are now found by Go to Definition, hover, references and the linter.
- **`unused-paragraph`** uses real reachability (PERFORM, THRU ranges, GO TO, fall-through) instead of naming conventions.
- **`perform-range-exit`** catches a `GO TO` that leaves the range of a `PERFORM` (the classic forgotten `THRU`).
- **Faster linter**: about 20% faster on large sources.

Every rule can be switched off, or have its severity changed, in the settings (`cobolLens.linter.rules.*`).
