# Balanced Review Chamber Summary

Phase: L5 (single chamber + FP check)  
Repository: `pi-agent-fabric`  
Completed: 2026-10-14  
Mode: balanced  
Survivor cap: 12 (2 survivors)

## Scope and method

Reviewed all Phase L4/L3 draft findings present in `piolium/findings-draft/`:

- `l4-001-policy-selected-command-execution.md`
- `l4-002-factory-symlink-path-escape.md`
- `p4-001-dashboard-external-url-allowlist.md`

The review used the knowledge-base report, manual attack-surface inventory, source/sink flow inventory, and candidate summary. Each draft was challenged as an ideation hypothesis, tested for false-positive conditions, and then given a final synthesis verdict. Severity was recalibrated for the required attacker position and deployment assumptions.

## Review decisions

### l4-001 — Repository policy can select an arbitrary validation executable

**Ideator challenge:** This may be intended behavior: repository tests commonly execute project-defined commands, and `execFile` plus shell-character rejection prevents classic shell injection. The hypothesis is only meaningful if the checkout or policy is untrusted and the factory process has sensitive privileges.

**Defense / FP check:** Confirmed controls are non-shell `execFile`, worktree cwd isolation, shell-metacharacter rejection, and a 4 MiB output cap. They do not allowlist executables, reject absolute paths, scrub inherited environment/PATH, impose timeout/resource limits, or terminate process trees. The code path is reachable from repository policy through `runBuildStage` into `runConfiguredValidation`.

**Synthesizer verdict: VALID**  
**Severity: MEDIUM**  
**Rationale:** Repository-controlled policy reaches a local privileged process-execution sink, and the existing controls prevent shell syntax but do not constrain which executable runs or what inherited credentials/resources it can access; local checkout control and operator/build invocation are material preconditions, so HIGH is downgraded to MEDIUM.

**Pre-FP gate:** passed. Attacker control is explicit (`.pi/factory.json`), the repository-to-process trust boundary is confirmed, production code is reachable, and the defense search identified no complete executable/environment boundary.

**Finding draft:** `piolium/findings-draft/p8-001-policy-selected-command-execution.md`

### l4-002 — Pre-existing factory symlinks can redirect durable writes

**Ideator challenge:** Job IDs are slugged and operator-supplied IDs are validated, so this is not a conventional traversal issue. The claim must be limited to an attacker who can prepare filesystem topology before execution; direct mutation of the same state tree may otherwise make the impact redundant.

**Defense / FP check:** Confirmed safe job IDs, locking, atomic board replacement, and recursive directory creation. The path helpers and all identified write paths lack `lstat`/realpath containment, no-symlink, ownership, or permission checks. A pre-existing symlink in `factory` or `factory/jobs` is followed by `mkdir`, lock, event, artifact, and atomic-write operations. This is a reachable filesystem-boundary weakness in production code, not merely a scanner match.

**Synthesizer verdict: VALID**  
**Severity: MEDIUM**  
**Rationale:** A local attacker or untrusted checkout can redirect extension-owned durable writes across the repository-state boundary because parent symlink topology is trusted, while locks and atomicity do not validate the target; local filesystem preparation and operator execution are required, so HIGH is downgraded to MEDIUM.

**Pre-FP gate:** passed. Attacker control is verified as pre-existing filesystem topology, the trust-boundary crossing is confirmed, no admin/root access is required, and the defense search found no symlink/realpath containment control.

**Finding draft:** `piolium/findings-draft/p8-002-factory-symlink-path-escape.md`

### p4-001 — Dashboard external URL is not host-allowlisted

**Ideator challenge:** An arbitrary HTTPS destination can facilitate phishing or tracking, and the code comment suggests GitHub-only links. However, the dashboard is a static optional artifact, and external navigation is an intentional feature.

**Defense / FP check:** The page uses `textContent`, rejects non-HTTPS and control-character-obfuscated URLs, and applies `noopener`. The URL comes from persisted GitHub/board data. Exploitation requires a compromised/trusted GitHub response or an attacker who can modify the served board; in the latter case the attacker already controls the dashboard data and can provide arbitrary links directly. No independent remote or same-origin trust-boundary bypass is demonstrated, and deployment/authentication is outside this repository.

**Synthesizer verdict: FALSE POSITIVE**  
**Severity: --**  
**Rejection reason:** `piolium/findings-draft/p4-001-dashboard-external-url-allowlist.md` was marked `status: rejected-fp` with the reason that attacker control and an exploitable security boundary were not established. Host allowlisting remains a hardening recommendation, not a validated finding under this audit's quality gate.

**Finding draft:** --

## Chamber Summary

| Source Draft | Verdict | Normalized Severity | Finding Draft |
|---|---|---|---|
| `l4-001-policy-selected-command-execution.md` | VALID | medium | `piolium/findings-draft/p8-001-policy-selected-command-execution.md` |
| `l4-002-factory-symlink-path-escape.md` | VALID | medium | `piolium/findings-draft/p8-002-factory-symlink-path-escape.md` |
| `p4-001-dashboard-external-url-allowlist.md` | FALSE POSITIVE | -- | -- |

**Findings written:** 2  
**Rejected FP drafts:** 1  
**Surviving drafts:** 2  
**Patterns added:** 0  
**Variant candidates:** 0  
**Cap status:** within 12-draft limit

Status: CLOSED
