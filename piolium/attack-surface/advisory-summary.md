# Advisory Summary — Phase L1 (Intel)

Generated: 2026-10-14T14:27:49Z. Scope is published advisory and high-level dependency intelligence only; commit archaeology / Phase 2 was intentionally skipped.

## Repository Identity

- **Repository:** `arest/pi-agent-fabric`
- **Resolution:** Git remote (`git@github.com:arest/pi-agent-fabric.git`); package manifest independently confirms `https://github.com/arest/pi-agent-fabric.git`.
- **Package:** `@arest/pi-agent-fabric-factory` version `0.1.0`.
- **Primary ecosystem:** npm / TypeScript.
- **Runtime constraint:** Node.js `>=24`.
- **Git:** available; current branch `main`, commit `7491206657accbfa06cbf56e5b4ee453ee28620b`.

## Recent Advisories (last 24 months)

The 24-month window is 2024-10-14 through 2026-10-14. Four unique advisories were found through OSV for the direct optional peer dependency `@earendil-works/pi-coding-agent`; all were published in June 2026. The repository's current lockfile resolves that package to `1.1.0`, which is newer than every affected range below. CVSS scores are from NVD; CWE and affected/fixed ranges are from OSV/GHSA records.

| ID (GHSA / CVE) | Published | Severity | CVSS | Affected versions | Fixed version | CWE | Component / description |
|---|---:|---|---:|---|---|---|---|
| GHSA-jfgx-wxx8-mp94 / CVE-2026-54328 | 2026-06-17 | HIGH | 7.3 | `@earendil-works/pi-coding-agent` `>=0.74.0 <0.78.1` | `>=0.78.1` | CWE-379 | Temporary npm/git extension install paths were predictable, enabling local attacker-controlled extension loading on shared Linux hosts. Patch references include `a98e087e5d08ea2a536bf73dbb0aebb87c3ef72e` and `ea3465a8e371a12d0167a06b60f93878e3a3df44`. |
| GHSA-mqxh-6gq7-558m / CVE-2026-54325 | 2026-06-17 | MEDIUM | 4.4 | `@earendil-works/pi-coding-agent` `<0.79.0` | `>=0.79.0` | CWE-829 | Project-local extensions/resources loaded without an explicit repository trust decision, permitting code execution when Pi was started in an attacker-controlled repository. Patch references include `38f18be44727e669eb0a6e2eb8edb51b0232d83c`, `718215bd95b6fc6fa251580d27ea8aab857de390`, `89a92207f1c9303d53d822fd9b0ac21578834cb4`, `ce3a72444e1cc1eaa50475fb3378c7ffbb53ef49`, and `ff3e9df5f5b32368c20b0ef553a6834b3dee9350`. |
| GHSA-7v5m-pr3q-6453 / CVE-2026-54326 | 2026-06-16 | LOW | 2.5 | `@earendil-works/pi-coding-agent` `>=0.74.0 <0.78.1` | `0.78.1` | CWE-79 | C0-control-character handling could bypass Markdown URL scheme filtering in HTML session exports, creating an indirect XSS risk. Patch reference: `6cb23f9b5d5b6d1747672f535b167d0d809ac010`. |
| GHSA-r95r-rj6r-c39x / CVE-2026-54327 | 2026-06-17 | LOW | 2.2 | `@earendil-works/pi-coding-agent` `>=0.74.0 <0.78.1` | `>=0.78.1` | CWE-367 | A race during `auth.json` writes could briefly expose API/OAuth credentials to local users. Patch reference: `135fb545f99106a4a249274f129b90bc0a77d347`. |

**Assessment:** No listed advisory applies to the locked `@earendil-works/pi-coding-agent@1.1.0` based on the published ranges. This is version-range triage, not proof that the integration is safe. The advisories are directly relevant to the package's trust boundary, extension execution, filesystem state, credentials, and Markdown rendering.

**Source results:** OSV package query returned the four records above; NVD CVE lookups supplied numeric CVSS/CWE; GitHub repository advisory endpoint for `arest/pi-agent-fabric` returned an empty list. Local documentation contained no CVE/GHSA identifiers or first-party security advisory.

## Dependency Intelligence

### Direct declared dependencies

| Dependency | Declared / locked version | Relationship | Security relevance and context |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | optional peer `*`; dev `^1.1.0`; lock `1.1.0` | peer + dev | **High relevance.** Host extension API and project-local execution context; directly implicated by all four recent advisories. Verify consumer/runtime version independently because the peer range is unrestricted. |
| `@types/node` | `^24.0.0`; lock `24.19.2` | dev | Medium relevance: types for filesystem, child-process, crypto, path, and process APIs; does not ship at runtime. |
| `typescript` | `^5.9.3`; lock `5.9.3` | dev | Medium relevance: build/type-check toolchain; output is executable extension code. |

The lockfile contains 147 non-optional installed dependency entries plus 26 optional entries (mostly transitive dependencies of the Pi host package). `npm audit --json --omit=optional` reported zero known vulnerabilities at audit time for the installed tree. That result is not a substitute for reviewing the optional peer's consumer installation or future lockfile changes.

### Dependency-focused observations

1. The dominant risk is not a known vulnerable transitive library; it is the host-extension boundary. `extensions/factory.ts` imports the Pi API and is loaded by the host process.
2. The manifest's unrestricted optional peer range (`*`) can permit consumers to run a vulnerable or behaviorally incompatible Pi host even when this repository's development lockfile is current. A bounded minimum/fixed security baseline should be considered in later phases.
3. Runtime-sensitive operations use Node built-ins: `node:child_process` for `git` and configured build commands, `node:fs/promises` for job artifacts/state, `node:path`, and `node:crypto` for locks/UUIDs. These are first-party attack-surface dependencies rather than npm advisories.
4. No Dockerfile, CI workflow, datastore, external SaaS SDK, or vendored third-party source was identified in the repository-level inventory pass. GitHub is an external service accessed through the `gh` executable and GraphQL/PR adapters.

## Architecture Hints

- **Execution model:** a local TypeScript Pi extension orchestrates a durable factory workflow. It creates specs, build artifacts, review/approval artifacts, worktrees, and recovery state on the filesystem.
- **Trust boundaries:** operator/Pi host → repository workspace; repository/job artifacts → parser/validator; factory process → local `git`/build executables; factory process → GitHub via `gh`; untrusted repository content → Markdown/spec/review parsers and potentially configured build commands.
- **Transports and integrations:** local filesystem and locks; subprocess execution (`git`, arbitrary commands represented by build validation input); GitHub CLI/API for identity, permissions, PR publication, and recovery; no inbound HTTP server was found.
- **High-risk flows for later review:**
  - repository-controlled project resources or extension loading through the Pi host (directly aligned with CVE-2026-54325);
  - build validation command parsing/execution in `src/workflow/build-stage.ts`;
  - path construction for job IDs, worktrees, artifacts, and recovery files;
  - secret sanitization and GitHub credential/URL handling;
  - Markdown/spec/review parsing and generated dashboard HTML (aligned with the host's historical HTML-export XSS advisory).
- **Priority implication:** Phase 3 DFD slices should center on workspace/artifact parsing, subprocess execution, and GitHub publication. Phase 5 should probe repository-controlled inputs, path/lock races, command boundaries, and extension trust assumptions.

## Coverage Gaps

- GitHub global Security Advisory data was not used as a package inventory because the unauthenticated GraphQL listing is global and was not reliably filterable in this run; the package-specific OSV records and NVD lookups were used instead. The target repository's own GitHub advisory endpoint was queried and returned no advisories.
- NVD keyword search for `pi-agent-fabric` returned zero results; individual NVD CVE lookups succeeded for the four OSV aliases.
- No first-party CVE/GHSA identifiers, changelog security records, or matching security commit messages were found locally. Phase 2 commit archaeology and patch-diff validation were explicitly skipped per task instructions.
- This is high-level dependency intelligence, not a complete transitive SBOM: transitive packages were counted from the lockfile but not individually advisory-enumerated.
- No lockfile-to-runtime consumer verification is possible for the optional peer dependency; the repository lockfile's `1.1.0` is a development/test resolution, while downstream consumers may supply another Pi version.
- No Docker, CI, datastore, or vendored-code signals were found; absence is based on repository inspection, not deployment-environment verification.
