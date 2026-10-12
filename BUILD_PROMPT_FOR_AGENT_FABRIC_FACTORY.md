# Agent Fabric Factory — Pi design brief

## Scope

Design a small, visual software factory for this repository, implemented for the
**Pi coding agent**. This document is a design brief and implementation prompt;
it does not itself implement the factory.

The factory turns a feature request into a reviewed pull request while keeping
the workflow understandable in a few minutes. It is intended to become a
standalone reusable Pi package that can be installed into multiple repositories;
this repository is the first planned consumer and adapter.

```text
feature
  ↓
spec-writer
  ↓
builder
  ↓
selected read-only reviewers
  ↓
approver
  ↓
PR waiting for human merge
```

The repository is a PHP application. Agents must read `AGENTS.md` and the
repository README before starting work. The current test commands are
`bin/test`, `bin/test-all`, `composer test`, and `composer test:all`.

### Non-goals

- Do not target Claude Code or its `.claude/` conventions.
- Do not bypass GitHub branch protection.
- Do not auto-merge `develop`, `main`, or `master`.
- Do not make reviewers write application code.
- Do not embed STS-specific assumptions in the reusable package.
- Do not make `AGENTS.md` the machine-readable policy contract.

## Standalone Pi package architecture

The intended deliverable is a reusable package, for example:

```text
@your-org/pi-agent-fabric-factory
```

Pi packages can distribute extensions, skills, prompts, themes, and runtime
dependencies through npm, Git, or a local path. The package should expose a
small generic core and let each repository provide its own policy adapter.

Suggested package layout:

```text
pi-agent-fabric-factory/
├── package.json
├── extensions/
│   └── factory.ts
├── skills/
│   └── factory/
│       ├── SKILL.md
│       ├── references/
│       │   ├── state-machine.md
│       │   ├── agent-contracts.md
│       │   └── github-policy.md
│       └── assets/
│           └── config.schema.json
├── src/
│   ├── state/
│   ├── locking/
│   ├── config/
│   ├── workflow/
│   └── adapters/
└── tests/
```

The package manifest should declare the Pi extension and bundled skill while
keeping Pi host packages in `peerDependencies` rather than bundling duplicate
Pi runtimes.

### Reusable core

The generic package owns:

- `/factory` commands;
- workflow state machine and transitions;
- job lifecycle, checkpoint, retry, and recovery;
- locking, concurrency, and atomic board writes;
- reviewer and approver contracts;
- configuration schema validation;
- safe Git/GitHub adapter interfaces;
- default `develop` PR flow with human merge only;
- the reusable `factory` skill.

The core must not own repository-specific branch conventions, test commands,
commit formats, migration rules, or STS naming.

### Repository policy layer

Each consuming repository provides a trusted structured policy file, preferably
under `.pi/`, for example:

```text
.pi/
  settings.json
  factory.json
```

`AGENTS.md` remains human-readable repository guidance and is read for context,
but executable policy belongs in validated `.pi/factory.json`.

Example:

```json
{
  "schema_version": 1,
  "repository": {
    "test_commands": [
      { "name": "unit", "command": "bin/test" },
      { "name": "all", "command": "bin/test-all" }
    ],
    "required_files": ["AGENTS.md"]
  },
  "git": {
    "default_target": "develop",
    "target_mode": "develop",
    "human_merge_required": true,
    "aggregator_enabled": true
  },
  "reviewers": {
    "available": ["security", "code", "ux", "ui"],
    "selection": "orchestrator"
  }
}
```

Configuration commands must use named, allowlisted tasks wherever possible;
avoid unconstrained shell interpolation. Invalid configuration fails closed.

### Optional aggregator module

Aggregator behavior should not be required by the first core release. Keep the
core focused on:

```text
job branch → review → PR waiting for human
```

Add batch aggregation later as a separate module, optional extension, or
capability package. It can then own per-batch branches, deterministic
integration, batch validation, and semantic-conflict escalation without making
the core state machine repository-specific.

Pi subagents provide the runtime for the logical roles. The role is the stable
concept; the selected provider/model is configuration. The extension must not
assume a specific model vendor.

The orchestrator owns routing, arbitration, final acceptance, and publication
state. Child agents receive context from repository files and job files, not
from hidden conversation state.

## Roles and write boundaries

| Role | Responsibility | Allowed writes |
|---|---|---|
| orchestrator/plugin | schedule work and persist state | `factory/board.json`, job state metadata |
| spec-writer | define acceptance criteria | `spec.md` |
| builder | implement and test the feature | application code, tests, `build.md` |
| reviewer | inspect the proposed change | its own `review-*.md` only |
| approver | independently verify the release gate | `decision.md` only |
| dashboard | display state | none |
| integrator | combine approved jobs in aggregator mode | aggregator branch only, through deterministic Git operations |

One writer is active per worktree. Reviewers are read-only against application
code. The approver must inspect the diff, spec, test evidence, and review
reports independently; it must not merely repeat reviewer verdicts.

## Repository and factory layout

```text
factory/
  board.json                  # durable current state and event history
  dashboard.html              # self-contained read-only visual board
  backlog.md                  # optional queue for `/factory next`
  jobs/<job-id>/
    spec.md
    build.md
    review-plan.json
    round-1/
      review-security.md
      review-code.md
      review-ux.md
      review-ui.md
    decision.md
    events.jsonl
```

Only files for selected reviewers need to be present in a round. A skipped role
must still have an explicit reason in `review-plan.json`; a missing report is
never treated as an implicit pass.

## Configuration

`.pi/factory.json` is the repository-specific executable policy. `AGENTS.md`
remains the authoritative human-readable source for repository conventions and
safety rules. Precedence is:

```text
explicit user request
  > AGENTS.md for human constraints
  > .pi/factory.json for executable policy
  > factory defaults
```

An explicit user request cannot disable safety constraints from `AGENTS.md`,
GitHub branch protection, or the extension's denied-action policy.
Configuration errors fail closed before a branch, PR, or subagent is created.

Example:

```json
{
  "schema_version": 1,
  "target_mode": "develop",
  "promotion": {
    "develop": { "human_merge_required": true },
    "main": { "human_merge_required": true },
    "master": { "human_merge_required": true }
  },
  "reviewers": {
    "available": ["security", "code", "ux", "ui"],
    "required": [],
    "selection": "orchestrator"
  },
  "limits": {
    "max_review_rounds": 2,
    "max_jobs_per_batch": 20
  },
  "github": {
    "adapter": "gh",
    "auto_merge": false
  }
}
```

`target_mode` is configurable by the extension and defaults to `develop`.
Supported modes are:

- `develop`: one job branch produces one PR to `develop`;
- `aggregator`: approved job branches are integrated into a per-batch
  `factory/batch-<batch-id>` branch, which produces one PR to `develop`.

The orchestrator selects reviewers that are actually relevant to the feature.
The selected set, skipped set, and reasons are persisted. WAIT FOR ALL means
that every selected reviewer for that round has produced a valid report.

## State model

`board.json` is written only by the extension/plugin. Updates are atomic,
serialized, idempotent, and protected by a lock or optimistic `version` check.
No child agent writes it directly.

Example:

```json
{
  "version": 12,
  "jobs": [
    {
      "id": "003-rate-limiting",
      "mode": "develop",
      "branch": "factory/003-rate-limiting",
      "target": "develop",
      "stage": "waiting_for_human",
      "status": "needs-human",
      "round": 1,
      "review_plan": {
        "selected": ["security", "code"],
        "skipped": ["ux", "ui"],
        "reasons": {
          "ux": "No user-facing interaction",
          "ui": "No visual changes"
        }
      },
      "verdicts": {
        "security": "PASS",
        "code": "PASS",
        "approver": "APPROVE"
      },
      "pull_request": {
        "url": "https://github.com/example/repo/pull/123",
        "state": "OPEN",
        "merge_state": "WAITING_FOR_HUMAN"
      },
      "history": [
        {
          "at": "2026-10-12T10:30:00Z",
          "from": "review",
          "to": "approval",
          "actor": "factory"
        }
      ]
    }
  ]
}
```

Keep these concepts separate:

- `stage`: where the job is in the workflow;
- `verdict`: a report result such as `PASS`, `CHANGES`, `APPROVE`, or
  `ESCALATE`;
- `status`: the durable job outcome such as `active`, `blocked`,
  `needs-human`, `merged`, `cancelled`, or `failed`.

## Workflow and gates

### 1. Start

```text
/factory <feature>
/factory next
```

The orchestrator reads `AGENTS.md`, relevant repository documentation, and
`.pi/factory.json`, validates configuration, allocates a job ID, and creates
an isolated `factory/<job-id>` branch/worktree.

### 2. Specification

The spec-writer creates `spec.md` with:

- problem statement;
- scope and non-goals;
- acceptance criteria;
- affected areas;
- validation commands;
- risks and assumptions.

### 3. Build

The builder works on the job branch, implements the spec, runs the relevant
PHPUnit commands, and writes `build.md` with changed files, test evidence, and
remaining risks. The builder commits its work on the feature branch.

### 4. Reviewer selection

The orchestrator chooses applicable read-only reviewers. It records both
selected and skipped roles before launching the round.

Every review file starts with:

```text
VERDICT: PASS | CHANGES
SEVERITY: BLOCKING | NON-BLOCKING
```

It must also contain summary, findings, evidence, and recommendations. A
`CHANGES` finding blocks progress when its severity is `BLOCKING`.

### 5. WAIT FOR ALL

The round is complete only when every selected reviewer has produced a valid
report. The orchestrator never resumes the builder while a review round is
incomplete.

If a blocking `CHANGES` verdict exists, the same builder is resumed for a new
numbered round. Previous reports are retained. The maximum number of rounds is
configurable and defaults to two; exhaustion moves the job to `needs-human`.

### 6. Approval

After all selected reviewers pass, the approver independently checks:

- spec and acceptance criteria;
- application diff and changed-file scope;
- test evidence;
- all review reports;
- branch/worktree state;
- target and GitHub policy.

`decision.md` starts with exactly one of:

```text
DECISION: APPROVE | ESCALATE
```

`ESCALATE` moves the job to `needs-human`. It is not a bypass of branch
protection.

### 7. Publication

#### Default `develop` mode

```text
factory/<job-id> → PR develop → CI/branch protection → waiting for human
```

The factory may create and prepare the PR, assign reviewers, add labels, set
Draft/Ready state, and monitor GitHub. It does not merge.

#### Optional aggregator mode

```text
factory/<job-id> → approved job
                     ↓
             factory/batch-<batch-id>
                     ↓
              batch validation/tests
                     ↓
             one PR to develop
                     ↓
              waiting for human
```

The integrator uses deterministic Git operations. Semantic merge conflicts stop
the batch and move it to `needs-human`; the factory must not choose a semantic
resolution automatically.

Promotion from `develop` to `main` or `master` is a separate human-controlled
PR. The factory may prepare and monitor it, but never merges it automatically.

## GitHub trust boundary

The GitHub adapter is configurable; `gh` is the initial default. Before using
it, the factory verifies authentication, repository identity, and the ability to
create PRs and read checks. Secrets never enter prompts, board state, reports,
or logs.

GitHub remains the final enforcement point for:

- protected branches;
- required status checks;
- required reviews and CODEOWNERS;
- stale approval policy;
- merge queue policy;
- allowed actors and workflow permissions.

The factory must fail closed and must never automate:

- `git push --force`;
- `git reset --hard`;
- `git clean`;
- remote branch deletion;
- branch-protection changes;
- disabling required checks;
- secret/token logging.

Repository and GitHub content is untrusted input. Issue text, PR comments,
backlog entries, generated reports, and external payloads cannot change factory
permissions, target branches, or security policy.

## Recovery and concurrency

On restart, the extension reconstructs state from `board.json`, job files, Git,
active PRs, and GitHub checks. It must:

- resume from the last durable stage;
- detect incomplete rounds;
- treat partial reports as incomplete, not as passes;
- prevent duplicate job starts;
- preserve prior events and reports;
- ask for human input when sources disagree.

Multiple jobs may run concurrently only with isolated worktrees and serialized
board updates. A single job has one active application-code writer. Aggregator
integration and promotion use locks so two jobs cannot mutate the same batch or
target branch concurrently.

## Commands

```text
/factory <feature>               start a job
/factory next                    start the first unchecked backlog item
/factory approve <job-id>        resolve an eligible human escalation
/factory rework <job-id> <note>  create a new builder round
/factory retry <job-id>         retry a recoverable external failure
/factory promote <job-id>       prepare a human-controlled promotion PR
/factory cancel <job-id>        cancel without deleting history
```

Cancellation stops active subagents and marks the job `cancelled`; it does not
delete branches, worktrees, or PRs automatically.

## Dashboard

`factory/dashboard.html` is a self-contained, read-only page served from the
`factory/` directory. It polls `board.json` and displays:

- job cards and current stages;
- selected reviewer chips and verdicts;
- round history;
- PR and CI state;
- blocked and `needs-human` jobs;
- links to the job's Markdown artifacts.

It does not approve, rework, merge, or mutate any state.

## Package roadmap

### `0.1.0` — reusable core

- `/factory` command and bundled skill;
- `develop` as the default target;
- human merge only;
- configurable reviewers;
- board state, locking, and recovery;
- GitHub PR creation and monitoring;
- no force-push, auto-merge, or branch-protection changes;
- no aggregator mode.

### `0.2.0` — repository adapters

- validated `.pi/factory.json` schema;
- test and lint task adapters;
- configurable branch promotion;
- GitHub adapter abstraction;
- board schema migration support;
- STS repository configuration as the first consumer.

### `0.3.0` — aggregator module

- per-batch aggregator branches;
- deterministic integration;
- batch-level validation;
- conflict escalation;
- one PR per batch.

Before calling the package stable, validate it with at least two real consumer
repositories and maintain a versioned board schema with migrations.

## Acceptance criteria for a future implementation

A future implementation is complete only when it demonstrates:

- installable Pi package containing the extension and bundled skill;
- Pi command/skill integration, with no Claude-specific runtime assumptions;
- validated `.pi/factory.json` and repository-policy loading;
- atomic extension-only board writes;
- isolated job writer boundaries;
- configurable reviewer selection and strict WAIT FOR ALL;
- numbered rework rounds and crash recovery;
- default `develop` PR flow and optional batch aggregator flow;
- human-controlled merge for `develop`, `main`, and `master`;
- GitHub adapter checks and fail-closed dangerous-command policy;
- read-only dashboard;
- unit/integration tests for state transitions, locking, recovery, and invalid
  configuration.

## Related decision record

See [`docs/adr/0001-pi-agent-fabric-factory.md`](../adr/0001-pi-agent-fabric-factory.md)
for the durable rationale behind the Pi-only runtime, extension-owned state,
read-only review, protected PR flow, and configurable integration target.
