# Agent contracts

A **role** is a stable concept; the Pi subagent, provider, and model that
implement it are configuration. The orchestrator (the extension) owns routing,
arbitration, final acceptance, and publication state.

## Write boundaries

| Role | Responsibility | Allowed writes |
|---|---|---|
| orchestrator / extension | schedule work and persist state | `factory/board.json`, job state metadata |
| spec-writer | define acceptance criteria | `spec.md` |
| builder | implement and test the feature | application code, tests, `build.md` |
| reviewer | inspect the proposed change | its own `review-*.md` only |
| approver | independently verify the release gate | `decision.md` only |
| dashboard | display state | none |
| integrator | combine approved jobs (aggregator mode) | aggregator branch only, via deterministic Git operations |

One writer is active per worktree. Reviewers and approvers are read-only against
application code: a review must not silently change the implementation. Child
agents receive context from repository files and job files, never from hidden
conversation state.

## Job artifact layout

```text
factory/jobs/<job-id>/
  events.jsonl
  spec.md
  build.md
  review-plan.json
  round-1/
    build.md
    review-plan.json
    review-security.md
    review-code.md
    review-ux.md
    review-ui.md
  decision.md
```

Only files for selected reviewers need to be present in a round. A skipped role
must still have an explicit reason in `review-plan.json`; a missing report is
never treated as an implicit pass.

When a round closes into rework or escalation, its reviewer selection and the
build evidence it reviewed are copied into the round directory (`round-N/
review-plan.json` and `round-N/build.md`) before the next round overwrites the
live files at the job root. Review reports are already per round and are never
deleted, so every closed round's evidence is retained.

## Spec contract

`spec.md` is the durable contract between the spec-writer and every later role.
It is a Markdown document whose sections are level-2 headings. Heading matching
is case-insensitive and punctuation-insensitive, so `## Scope & non-goals`
matches `## Scope`.

Required sections, all of which must have real content before a job can leave
the `spec` stage:

- **Problem**
- **Scope**
- **Acceptance criteria**
- **Validation commands**
- **Risks and assumptions**

**Affected areas** is expected by the full contract and is recognized by the
validator, but is advisory in this slice. A heading whose body is empty,
whitespace, or only an HTML comment counts as missing; a scaffold therefore
never passes. When a heading is repeated, the first occurrence is the one that
counts. Content inside fenced code blocks is never read as a heading.

## Build evidence

`build.md` records changed files, the validation commands that were run with
their outcomes, and remaining risks.

## Review report format

Every review file starts with:

```text
VERDICT: PASS | CHANGES
SEVERITY: BLOCKING | NON-BLOCKING
```

followed by summary, findings, evidence, and recommendations. A `CHANGES`
verdict blocks progress when its severity is `BLOCKING`.

## WAIT FOR ALL

A round is complete only when **every** selected reviewer has produced a valid
report. The orchestrator never resumes the builder while a round is incomplete.
Partial or malformed reports are incomplete, not passes.

## Rework rounds

A round that contains a `CHANGES` verdict with `BLOCKING` severity closes the
round and opens the next numbered build round:

- the board's `round` increments, the stage returns to `build`, and the job stays
  `active`;
- the closed round's selection and reviewed build evidence are retained under
  `round-N/`, and its reports stay in place;
- the resumed builder receives the round number, the retained reports, and the
  blocking findings from the previous round, so rework answers specific findings
  rather than re-running blind.

Board history and `events.jsonl` record the round on every entry, so a repeated
event name (`build_complete`, `review_started`) stays attributable to its round.

When a blocking round reaches `policy.limits.max_review_rounds`, the job does not
open another round. The limit counts total review rounds, so the final permitted
round escalates instead of starting a rework. The job moves to status
`needs-human`, stage `review`, with a `review_exhausted` history entry, and the
extension refuses to run review again until an operator acts.

Resuming a rework round requires the prior round's plan and reports. If a
retained report is missing or no longer satisfies the report contract, the
factory fails closed: it does not resume the builder, records
`build_failed:rework_context`, and moves the job to `needs-human`. Automation
Never guesses at findings a human can read.

## Approval

`decision.md` starts with exactly one of:

```text
DECISION: APPROVE | ESCALATE
```

Before deciding, the approver independently checks the spec and acceptance
criteria, the diff and changed-file scope, test evidence, all review reports,
branch/worktree state, and target and GitHub policy. Repeating reviewer verdicts
is not an independent check. `ESCALATE` moves the job to `needs-human` and is
never a bypass of branch protection.
