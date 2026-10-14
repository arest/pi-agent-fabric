# Security Audit Report: pi-agent-fabric

## Executive Summary

The audit identified two confirmed MEDIUM-severity findings in the local factory workflow. First, repository-controlled validation policy can select and execute an arbitrary executable with the factory user's privileges and inherited environment, allowing code execution and possible credential or filesystem exposure when an untrusted checkout is built. Second, pre-existing symlinks in the factory state tree can redirect durable job and artifact writes outside the intended repository boundary. Both findings were reproduced with executed proof-of-concept scripts. The project is a local Pi extension rather than a network-facing service, so the primary risks are at the repository-to-process and repository-to-filesystem trust boundaries; deployment-specific exposure of the static dashboard and host-level extension loading remain outside the package's independent authorization model.

## Findings by Severity

| ID | Directory | Title | Severity | PoC Status | Report |
|---|---|---|---|---|---|
| M1 | [`M1-policy-selected-command-execution`](findings/M1-policy-selected-command-execution/) | Repository policy can select an arbitrary validation executable | MEDIUM | Executed | [`report.md`](findings/M1-policy-selected-command-execution/report.md) |
| M2 | [`M2-factory-symlink-path-escape`](findings/M2-factory-symlink-path-escape/) | Pre-existing factory symlinks can redirect durable writes | MEDIUM | Executed | [`report.md`](findings/M2-factory-symlink-path-escape/report.md) |

### Medium

#### M1 — Repository policy can select an arbitrary validation executable

- **Summary:** A repository-controlled `test_commands[].command` is passed to `execFile` after only syntax filtering; the executable is not restricted to an approved allowlist or trusted path.
- **Impact:** A contributor or other actor able to modify a checkout can cause a trusted local operator or automation to execute an attacker-selected program with the factory user's OS privileges and inherited environment. The program may read reachable files and credentials, modify state, exfiltrate data, or consume local resources.
- **Root Cause:** Policy validation checks schema shape and selected shell metacharacters, but treats an executable string as trusted data. Execution lacks executable identity constraints, environment scrubbing, timeout/resource limits, and sandboxing.
- **Key Code Reference:** `src/config/policy.ts:101-118` accepts the command; `src/workflow/build-stage.ts:140-147` runs configured validations; `src/workflow/build-stage.ts:228-238` tokenizes the command and invokes `execFile`.
- **PoC Status:** Executed — [`poc.mjs`](findings/M1-policy-selected-command-execution/poc.mjs), with evidence in [`evidence/`](findings/M1-policy-selected-command-execution/evidence/).
- **Detailed Report:** [`findings/M1-policy-selected-command-execution/report.md`](findings/M1-policy-selected-command-execution/report.md)

#### M2 — Pre-existing factory symlinks can redirect durable writes

- **Summary:** Factory path helpers use lexical `path.join` paths and ordinary recursive filesystem operations without checking existing symlinks or realpath containment.
- **Impact:** A local process or contributor-controlled checkout that prepares a symlink under `factory/` can redirect job events, artifacts, locks, board state, or related writes to an attacker-selected or unintended location, causing integrity loss, disclosure, denial of service, or cross-project state confusion.
- **Root Cause:** The implementation equates lexical paths beneath `cwd` with filesystem paths beneath `cwd`; `lstat`, realpath containment, ownership, and no-symlink checks are absent before durable writes.
- **Key Code Reference:** `src/state/paths.ts:24-61` derives state paths; `src/workflow/start-job.ts:58-63` recursively creates job directories; `src/state/board-store.ts:73-83`, `src/state/atomic-write.ts:13-25`, and `src/state/lock.ts:101-108` operate through derived paths.
- **PoC Status:** Executed — [`poc.js`](findings/M2-factory-symlink-path-escape/poc.js), with evidence in [`evidence/`](findings/M2-factory-symlink-path-escape/evidence/).
- **Detailed Report:** [`findings/M2-factory-symlink-path-escape/report.md`](findings/M2-factory-symlink-path-escape/report.md)

## Attack Surface Summary

The repository is a local Node.js/TypeScript Pi extension with a filesystem-backed workflow state machine, Git/GitHub integration, and an optional static dashboard. It does not implement an inbound HTTP API, database, WebSocket service, or server-side authentication layer.

- **Local command surface:** [`extensions/factory.ts`](../extensions/factory.ts) registers the host-local `/factory` command. Access control and operator identity are delegated to the Pi host.
- **Repository policy and process execution:** [`src/config/policy.ts`](../src/config/policy.ts) reads `.pi/factory.json`; [`src/workflow/build-stage.ts`](../src/workflow/build-stage.ts) reaches the validation subprocess boundary.
- **Filesystem state boundary:** [`src/state/paths.ts`](../src/state/paths.ts), [`src/state/board-store.ts`](../src/state/board-store.ts), [`src/state/atomic-write.ts`](../src/state/atomic-write.ts), and [`src/state/lock.ts`](../src/state/lock.ts) manage board, jobs, locks, and artifacts under `factory/`.
- **Git/GitHub boundary:** [`src/workflow/gh.ts`](../src/workflow/gh.ts) and publication adapters invoke local `git`/`gh` and rely on their credentials and repository context.
- **Static dashboard:** [`factory/dashboard.html`](../factory/dashboard.html) is read-only client-side presentation. Any server exposing `factory/` must provide access control; the package does not implement it.

See the detailed attack-surface artifacts:

- [`knowledge-base-report.md`](attack-surface/knowledge-base-report.md) — architecture, trust boundaries, DFD/CFD slices, and controls.
- [`manual-attack-surface-inventory.md`](attack-surface/manual-attack-surface-inventory.md) — entry points, sinks, attacker sources, and hidden control channels.
- [`source-sink-flows-all-severities.md`](attack-surface/source-sink-flows-all-severities.md) — static-analysis flow coverage and limitations.
- [`unauthenticated-surface.md`](attack-surface/unauthenticated-surface.md) — no HTTP/API routes; conditional dashboard and host-boundary exposure.
- [`balanced-chamber-summary.md`](attack-surface/balanced-chamber-summary.md) — review-chamber decisions and false-positive disposition.
- [`advisory-summary.md`](attack-surface/advisory-summary.md) — advisory intelligence summary.

## Coverage Gaps

- The package has no independent authentication or authorization layer; Pi host command authorization, project-local resource loading, and host trust behavior were not fully controllable from this repository.
- No inbound HTTP/API implementation was present for direct testing. Security of any deployment serving `factory/` or the dashboard is external to this codebase.
- CodeQL recognized no modeled entry points or sinks in this local extension, despite producing SARIF results; custom process and filesystem boundaries therefore required manual review. This is a scanner-model limitation, not evidence that those boundaries are safe.
- GitHub CLI credentials, local `git`/`gh` binaries, PATH, Git configuration, and deployment permissions are external trust anchors. Their security was assessed only through repository-side preflight and invocation logic.
- The audit did not include a hostile Pi host, malicious dependency package, operating-system compromise, or full multi-user race/fuzz campaign.
- No Critical or High findings were confirmed. The two confirmed findings require local checkout/filesystem influence plus an operator or automation invocation and are not unauthenticated remote RCE.

## Methodology Notes

The audit followed the balanced Piolium workflow at commit `7491206657accbfa06cbf56e5b4ee453ee28620b` on `main`:

- Advisory and repository intelligence collection, architecture inventory, dependency review, and attack-surface mapping.
- Knowledge-base construction with trust boundaries, data-flow/control-flow slices, and source/sink inventories.
- Static analysis using CodeQL artifacts and complementary manual analysis, followed by targeted review of the highest-impact process and filesystem boundaries.
- A balanced review chamber challenged candidate findings, performed defense/false-positive checks, and normalized severity. Three hypotheses were reviewed; two were confirmed and one dashboard URL hypothesis was rejected as a false positive.
- Real-environment PoC execution confirmed both surviving findings. The M1 PoC demonstrated attacker-selected validation execution and inherited environment access; the M2 PoC demonstrated durable event writes resolving outside the checkout through a pre-existing symlink.
- The complete finding reports and PoCs are retained in [`piolium/findings/`](findings/). No variant findings were identified.

## Conclusion

The project has a limited external attack surface because it is a local extension without an application server, but its security depends heavily on the trustworthiness of repositories and local execution environments. Remediation should prioritize treating repository validation commands as untrusted tasks—using an allowlist or isolated sandbox with a minimal environment and resource limits—and validating filesystem topology before every factory-owned durable write. Operators should also avoid serving factory artifacts without deployment-level access control and should treat the Pi host, local CLI credentials, and checkout provenance as security boundaries.
