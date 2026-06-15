# Contributing to COBOL Lens

Thanks for your interest in improving COBOL Lens. This project lives on feedback
from real COBOL developers, so bug reports, ideas, and test cases are all welcome.

## Reporting a bug

Open a [bug report](https://github.com/rendani-labs/cobol-lens/issues/new?labels=bug)
and include:

1. A **minimal COBOL snippet** that reproduces the problem (a few lines is ideal).
2. **Expected** vs **actual** behavior.
3. The **source format**: fixed or variable (`$SET SOURCEFORMAT(...)`).
4. Which feature is involved: navigation, hover, autocomplete, folding, or a
   specific linter rule (please mention the rule id, e.g. `redefines-size`).
5. Extension version and VS Code version.

A screenshot of the editor or the Problems panel is often the fastest way to
explain a glitch.

## Suggesting a feature or a new linter rule

Open a [feature request](https://github.com/rendani-labs/cobol-lens/issues/new?labels=enhancement)
and describe:

- The problem you want to solve or the convention you want enforced.
- A concrete COBOL example of correct and incorrect code.
- Whether it should default to `error`, `warning`, or `info`.

## Questions and discussion

For general questions, tips, or ideas that are not yet a concrete request, use
[GitHub Discussions](https://github.com/rendani-labs/cobol-lens/discussions).

## Developing locally

The extension is plain JavaScript (ES2020+), with no runtime dependencies and no
build step.

- Source lives in `src/`.
- The linter rules are in `src/cobol-linter.js`; diagnostic messages are in
  `src/messages.js` (English and Italian).
- Settings descriptions use `%key%` placeholders resolved by `package.nls.json`
  (English) and `package.nls.it.json` (Italian). Keep both files in sync.

### Running the tests

If Node.js is available:

```
npm test
```

Otherwise, use the bundled VS Code runtime fallback (Windows/PowerShell):

```
powershell -ExecutionPolicy Bypass -File tests/test-linter-regression.ps1
```

Exit code `0` means the tests passed.

## Pull requests

1. Keep changes focused and small.
2. Add or update a regression test when you fix a bug or add a rule.
3. Run the tests before pushing.
4. Use Conventional Commit messages (`feat:`, `fix:`, `chore:`, `docs:`,
   `refactor:`).
5. Documentation files must use plain ASCII characters only.

Thank you for helping make COBOL Lens better.
