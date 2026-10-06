## Make it yours

Point COBOL Lens at your copybooks and match your shop's conventions:

- `cobolLens.binaryStorage` -- `ibmcomp` or `noibmcomp`, must match your compiler (see the first step).
- `cobolLens.copyFolders` -- where to look for copybooks.
- `cobolLens.copyExtensions` -- extensions to try when resolving `COPY`.
- `cobolLens.programFolders` / `cobolLens.programExtensions` -- where to look for programs called with `CALL`.
- `cobolLens.sourceFormat` -- fixed / variable / free (also controls the column rulers).
- `cobolLens.language` -- language of the linter diagnostics (auto / English / Italian).
- `cobolLens.format.*` -- PIC column, indentation step and the optional section separators / blank lines of the formatter.

Every feature has its own on/off setting, so you can keep only what you need.
