# Security Policy

COBOL Lens is a self-contained VS Code extension: it has no runtime
dependencies, makes no network calls, and processes files only locally inside
your editor. The attack surface is therefore small, but security reports are
still welcome.

## Supported versions

Only the latest published version on the Visual Studio Marketplace receives
security fixes.

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| Older   | No        |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/rendani-labs/cobol-lens/security)
   of the repository.
2. Click **Report a vulnerability**.
3. Describe the problem, the affected version, and steps to reproduce
   (a minimal COBOL snippet is ideal).

You can expect an initial response within a reasonable time frame. Once a fix is
available it will be published as a new Marketplace release and noted in the
changelog.

## Scope

Examples of issues that are in scope:

- A crafted COBOL source or copybook that crashes the extension or causes a
  denial of service (for example, runaway parsing).
- Path traversal or unintended file access through copybook resolution.

Out of scope:

- False positives or false negatives in linter rules (please open a regular
  issue or feature request instead).
