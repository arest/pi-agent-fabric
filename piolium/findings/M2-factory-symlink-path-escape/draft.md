---
id: M2
phase: 8
sequence: 2
slug: factory-symlink-path-escape
verdict: valid
status: valid
severity: medium
severity_original: HIGH
poc_status: executed
PoC-Status: executed
Protocol: local
Auth-Required: no
Auth-Roles-Required: anonymous
pre_fp_flag: none
debate: piolium/attack-surface/balanced-chamber-summary.md
original_id: p8-002
---

# Pre-existing factory symlinks can redirect durable writes

## Summary
Factory path helpers trust pre-existing directory topology, allowing symlinked `factory` or `factory/jobs` components to redirect durable board, lock, event, and artifact writes outside the intended repository-owned state tree.

## Location
- `src/state/paths.ts:24-61` constructs paths with `path.join` and performs no symlink or realpath containment checks.
- `src/workflow/start-job.ts:58-63` recursively creates the job directory.
- `src/state/board-store.ts:73-83`, `src/state/atomic-write.ts:13-25`, and `src/state/lock.ts:101-108` operate through those derived paths without validating parent components.

## Attacker Control
A local unprivileged process or contributor-controlled checkout can prepare a symlink under `factory/` before the operator runs the factory. Generated job IDs are safe slugs, so the exploit relies on filesystem topology rather than crafted traversal input.

## Trust Boundary Crossed
The factory's intended repository-local state boundary is crossed when extension-owned writes follow a pre-existing symlink into an attacker-selected or unintended filesystem location.

## Impact
An attacker can redirect artifacts, events, locks, and potentially board state, causing integrity loss, disclosure, denial of service, or cross-project state confusion, subject to filesystem permissions and deployment layout.

## Evidence
`factoryPaths` and `jobDir` merely append components after resolving `cwd`; `fs.mkdir(..., { recursive: true })` follows pre-existing symlinked parents. Board locking, atomic temporary-file creation/rename, and lock creation likewise use derived paths and do not call `lstat`, `realpath`, or enforce ownership/no-symlink policy.

## Reproduction Steps
1. Before invoking the factory, replace `factory/jobs` (or `factory`) with a symlink to an attacker-selected writable directory.
2. Start a job from the affected checkout.
3. Observe `fs.mkdir` and subsequent event/artifact writes resolve through the symlink; similarly, a symlinked factory root redirects board locks and atomic writes.
4. Existing slug validation, exclusive lock creation, and atomic replacement do not detect or prevent the redirected parent.

The defense review confirmed safe generated job IDs, locking, and atomic board replacement, but found no parent `lstat`/realpath containment or ownership checks. Debate: `piolium/attack-surface/balanced-chamber-summary.md`.
