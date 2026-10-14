# L4 Balanced Probe Summary

Status: complete
Phase: L4 (Lite Probe Team)
Passes: 1
Selected slices: 2
Draft findings: 2

## Execution

The required knowledge-base report and candidate summary were present and read. The two highest-impact reachable slices selected were:

1. Repository-controlled validation policy to local subprocess execution.
2. Host cwd/job-derived paths to filesystem state, with emphasis on pre-existing symlink topology.

The manual inventory was written to `piolium/attack-surface/manual-attack-surface-inventory.md`.

## Inline hypothesis generation

### Backward-reasoner perspective

- **H1:** Trace the build-stage sink backward from `execFileAsync`: executable and argv originate in repository `.pi/factory.json` and reach execution after only shell-character filtering. This is a privileged command-selection path.
- **H2:** Trace durable writes backward from `fs.mkdir`, lock creation, and atomic rename: all paths originate from host cwd and plain `path.join`; a pre-existing symlink in `factory` can redirect the apparent repository-local target.

### Contradiction-reasoner perspective

- **H1 challenge:** `execFile` does prevent shell metacharacter injection, and policy rejects common shell syntax. That blocks shell injection but does not contradict arbitrary executable selection or inherited environment execution. H1 remains verified and is scoped to untrusted repository use.
- **H2 challenge:** Generated job IDs are slugified and operator IDs are regex-validated, so crafted traversal through the job ID is not supported. That does not address symlinked parent components; H2 remains verified and is scoped to attackers able to prepare the filesystem topology.

## Verified drafts

| ID | Finding | Severity | Evidence |
|---|---|---|---|
| `l4-001` | Repository policy can select an arbitrary validation executable | HIGH | `src/config/policy.ts:101-118`; `src/workflow/build-stage.ts:140-147,271-284` |
| `l4-002` | Pre-existing factory symlinks can redirect durable writes | HIGH | `src/state/paths.ts:24-61`; `src/workflow/start-job.ts:58-63`; `src/state/board-store.ts:73-83`; `src/state/atomic-write.ts:13-25` |

Drafts:

- `piolium/findings-draft/l4-001-policy-selected-command-execution.md`
- `piolium/findings-draft/l4-002-factory-symlink-path-escape.md`

## Verification performed

- Read all relevant implementation files and used numbered source inspection for file:line evidence.
- Grepped all `src` path and `test_commands` call sites to confirm the flows and alternate callers.
- Ran the complete repository test suite: **124 passed, 0 failed** (`npm test`, duration approximately 7.6 seconds).
- Existing tests confirm shell-syntax rejection, safe job-ID generation, locking, atomic writes, and command adapter restrictions. They do not establish executable allowlisting/environment isolation or no-symlink filesystem validation; those residual gaps are why both findings remain verified under their stated attacker preconditions.

## Coverage

| Surface | Covered | Result |
|---|:---:|---|
| `/factory` command and feature/job input | Yes | Dispatch and cwd boundary reviewed; feature-derived IDs are constrained. |
| `.pi/factory.json` policy | Yes | Shell syntax rejection reviewed; executable selection remains broad. |
| Build/worktree process execution | Yes | `execFile` sink and inherited execution context verified. |
| Factory board/artifact paths | Yes | Plain path joins and write operations reviewed. |
| Symlink/race topology | Yes | No symlink/realpath/ownership checks found in selected path. |
| GitHub publication | Limited | Adapter and identity checks inventoried; no separate draft produced in this single pass. |
| Dashboard/static serving | Inventory only | No server or public route exists in repository; deployment controls remain external. |
| HTTP middleware/proxy/header channels | Yes | None implemented in repository. |

Stop reason: single-pass L4 probe complete; selected slices covered and drafts written. No deep multi-team dispatch or iterative probe was performed.
