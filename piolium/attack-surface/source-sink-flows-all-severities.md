# CodeQL flow paths — all severities

- Database: `piolium/codeql-artifacts/db`
- Recognized entry points: **0**
- Recognized sinks: **0**
- SARIF results: **11**

## Results by rule
- `js/bad-tag-filter`: 2
- `js/client-side-unvalidated-url-redirection`: 1
- `js/code-injection`: 2
- `js/incomplete-multi-character-sanitization`: 4
- `js/incomplete-url-substring-sanitization`: 1
- `js/xss`: 1

## Informational/low-severity interpretation

CodeQL produced no note/none-level results in the built-in JavaScript security query pack. Structural enumeration recognized no RemoteFlowSource or modeled command/file/database sink in this local extension codebase; this is a coverage limitation, not proof of absence. The custom DFD/CFD boundaries are documented in the audit report.
