# pi-agent-fabric

A reusable Pi package that turns a feature request into a reviewed pull request
while keeping the merge human-controlled.

The package ships:

- a Pi **extension** that owns the `/factory` command and is the only writer of
  durable factory state;
- a Pi **skill** that documents the workflow, role contracts, and GitHub policy;
- a self-contained, read-only `factory/dashboard.html` operational dashboard.

## Status

Bootstrap, spec, builder, reviewer, approver, and publication slices are
implemented. `/factory <feature>` validates repository policy and creates a new
job scaffold, `/factory spec <job-id>` runs the spec-writer stage, and the
builder workflow runs in an isolated job worktree while capturing validated
`build.md` evidence. The review workflow selects configured read-only
reviewers, persists skipped roles and reasons, validates every report, waits
for all selected reports, and routes blocking findings into numbered rework
rounds that retain prior evidence or into human escalation when the round limit
is exhausted. The approval workflow runs an independent decision gate over
spec, implementation evidence, and policy context, then persists `APPROVE` or
`ESCALATE` as a distinct durable decision. The publication workflow performs a
GitHub preflight (auth, repository identity, PR capability, and checks-read
capability), opens or monitors a PR to `develop`, and moves approved jobs to
`waiting_for_human` with no auto-merge. Operator commands provide guarded
`approve`, `rework`, `retry`, `promote`, and `cancel` transitions that preserve
history and never delete work or merge. `/factory recover` reconciles every
job against its durable evidence — job artifacts, Git, and GitHub — and resumes
jobs from the last safe durable stage after a restart, escalating to a human
when sources disagree.

The read-only dashboard and orchestration-boundary regression suite are included.

```text
/factory <feature>                       start a job scaffold            (implemented)
/factory spec <job-id>                   complete the spec stage         (implemented)
/factory approve <job-id> [note]         resolve an approver ESCALATE    (implemented)
/factory rework <job-id> <note>          open the next builder round     (implemented)
/factory retry <job-id> [note]           clear a recoverable failure     (implemented)
/factory promote <job-id> [main|master]  prepare a promotion PR          (implemented)
/factory cancel <job-id> [note]          cancel, preserving all history  (implemented)
/factory recover                         reconcile jobs with durable evidence (implemented)
```

An operator command that is not eligible for the job's current state fails with
an explicit message and leaves the board untouched. `/factory next` remains
unavailable and reports so.

## Install

From a local checkout:

```bash
pi install /path/to/pi-agent-fabric
```

This registers the bundled extension and skill through the `pi` manifest in
`package.json`. Pi supplies the host packages, so
`@earendil-works/pi-coding-agent` is declared as an optional peer dependency and
is never bundled.

## Starting a job

```text
/factory Add rate limiting to the public API
```

creates:

```text
factory/
  board.json
  jobs/001-add-rate-limiting-to-the-public-api/
    events.jsonl
```

`factory/board.json` is extension-owned durable state: writes are serialized by
a lock, applied to a private copy, version-checked, and swapped in atomically.
Child roles never write it. If `.pi/factory.json` exists, it must be valid and
safe before any board or job artifact is created; otherwise safe `develop`
defaults apply. The job starts at stage `spec` with status `active`.

## Completing the spec stage

The spec-writer role owns `factory/jobs/<job-id>/spec.md`. Running
`/factory spec <job-id>` creates the contract scaffold when the artifact is
missing, validates it, and advances the job to `build` only when the required
sections (Problem, Scope, Acceptance criteria, Validation commands, Risks and
assumptions) have real content. An incomplete specification fails closed and
leaves the board at `spec`, so a later attempt resumes without duplicating
history:

```text
/factory Add rate limiting to the public API
# write the required sections into factory/jobs/001-.../spec.md
/factory spec 001-add-rate-limiting-to-the-public-api
```

## Development

Requires Node 24+ (tests run TypeScript directly through native type stripping).

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test
npm run check       # typecheck + tests
```

## Documentation

- `AGENTS.md` — contributor and agent guidance.
- `adr/0001-pi-agent-fabric-factory.md` — the architectural decision.
- `BUILD_PROMPT_FOR_AGENT_FABRIC_FACTORY.md` — the design brief.
- `skills/factory/` — workflow guidance loaded by Pi.

## Builder stage

The reusable `runBuildStage` workflow accepts a builder role and a worktree
provider. The default provider creates `factory/worktrees/<job-id>` with the
job branch through `git worktree`; tests and other hosts can inject a provider.
A lock inside the prepared worktree is held for the entire builder execution,
so jobs sharing a worktree cannot write application code concurrently.

The builder owns `build.md`, which must contain `## Changed files`,
`## Validation`, and `## Remaining risks`. Configured `.pi/factory.json`
validation commands run in the prepared worktree and their PASS/FAIL outcomes
are persisted in the validation section. Any failed validation, builder error,
or incomplete evidence blocks the job at `build` rather than advancing it to
review.

## Review stage

`runReviewStage` is the orchestration seam for configured reviewer roles. It
persists `review_plan` on the board and in
`factory/jobs/<job-id>/review-plan.json` before launching reviewers, then stores
each report at `factory/jobs/<job-id>/round-<n>/review-<role>.md`. Reports must begin
with `VERDICT` and `SEVERITY` and contain Summary, Findings, Evidence, and
Recommendations sections. Missing or malformed reports fail closed. Once every
selected report passes validation, non-blocking findings advance the job to
`approval`; blocking findings start the next numbered build round, or move the
job to `needs-human` when the configured round limit is exhausted.

A blocking round is closed durably: its reviewer selection and the build
evidence it reviewed are retained as `round-<n>/review-plan.json` and
`round-<n>/build.md` before the next round overwrites the live files, and the
round's reports stay in place. The resumed builder receives the round number,
the retained reports, and the blocking findings from the previous round, so
rework answers specific findings. Board history and `events.jsonl` record the
round on each entry, so `build_complete` and `review_started` appear once per
round instead of collapsing into a single durable event. If a retained report is
missing or malformed when a rework round opens, the factory fails closed to
`needs-human` rather than resuming the builder on incomplete findings.

## Approval stage

`runApprovalStage` is the orchestration seam for the approver role. The
approver writes `factory/jobs/<job-id>/decision.md`, which must declare
`DECISION: APPROVE|ESCALATE` and include independent-check sections for Spec
checks, Implementation evidence, and Policy context. The extension validates the
decision contract before mutating board state:

- `APPROVE` advances `approval -> publication` and persists
  `job.approval = "APPROVE"`.
- `ESCALATE` keeps stage `approval`, marks status `needs-human`, and persists
  `job.approval = "ESCALATE"`.

This decision is stored separately from reviewer verdicts (`job.verdicts`) so
approval remains a distinct durable gate.
