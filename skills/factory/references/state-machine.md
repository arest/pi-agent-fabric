# Factory state machine

The board is the durable record of job state. It lives at `factory/board.json`
and is written **only** by the extension. Child roles never write it.

## Vocabulary

Keep these three concepts separate:

- **stage** — where the job is in the workflow;
- **status** — the durable job outcome;
- **verdict** — the result declared by a review or approval report.

### Stages

```text
spec → build → review → approval → publication → waiting_for_human
```

| Stage | Meaning |
|---|---|
| `spec` | The spec-writer must produce the job specification. |
| `build` | The builder is implementing the spec in the job worktree. |
| `review` | Selected read-only reviewers are producing reports for the current round. |
| `approval` | The approver is performing the independent release-gate check. |
| `publication` | The factory is preparing and monitoring the PR. |
| `waiting_for_human` | The PR exists and only a human may merge it. |

### Statuses

`active`, `blocked`, `needs-human`, `merged`, `cancelled`, `failed`.

- `blocked` is recoverable contention or an external failure that can be retried.
- `needs-human` requires an explicit operator decision; automation must not guess.
- `merged` and `cancelled` are terminal.

### Verdicts

Review reports declare `PASS` or `CHANGES`. The approver declares `APPROVE` or
`ESCALATE`. Approval is stored separately from reviewer verdicts; it is not a
summary of them.

## Board document

```json
{
  "schema_version": 1,
  "version": 3,
  "jobs": [
    {
      "id": "001-rate-limiting",
      "feature": "Add rate limiting to the public API",
      "policy": { "v": 1, "source": "repo", "mode": "develop", "target": "develop" },
      "mode": "develop",
      "branch": "factory/001-rate-limiting",
      "target": "develop",
      "stage": "spec",
      "status": "active",
      "round": 1,
      "review_plan": null,
      "verdicts": {},
      "pull_request": null,
      "promotion": null,
      "created_at": "2026-10-12T10:30:00Z",
      "updated_at": "2026-10-12T10:30:00Z",
      "history": [
        { "at": "2026-10-12T10:30:00Z", "from": null, "to": "spec", "actor": "factory", "event": "job_created", "round": 1 }
      ]
    }
  ]
}
```

- `schema_version` identifies the document shape. An unknown version fails
  closed: an older writer never rewrites a newer board.
- `version` is a monotonic write counter used for optimistic concurrency.
- Writes are serialized by a lock, applied to a private copy, and swapped in
  atomically. History entries are append-only and prior artifacts are never
  deleted.
- History entries and `events.jsonl` records carry the `round` they belong to,
  so events that repeat across rework rounds (`build_complete`, `review_started`)
  stay distinguishable and are recorded once per round.

## Job ids

Job ids are `NNN-slug`, allocated under the board write lock from the highest
existing sequence, so concurrent starts cannot collide. The slug is derived from
the feature text and contains only `[a-z0-9-]`.

## Valid transitions

| Trigger | From | To |
|---|---|---|
| `/factory <feature>` | — | new job at `spec` / `active` |
| `/factory spec <job-id>` with a complete `spec.md` | `spec` | `build` |
| build evidence complete | `build` | `review` |
| all selected reviewers reported | `review` | `approval` |
| blocking `CHANGES` | `review` | `build` (round + 1, history retained) |
| round limit exhausted | `review` | status `needs-human`, stage `review` (history retained) |
| unreadable retained report on a rework round | `build` | status `needs-human`, stage `build` (`build_failed:rework_context`) |
| `APPROVE` | `approval` | `publication` |
| `ESCALATE` | `approval` | `needs-human` |
| PR opened | `publication` | `waiting_for_human` |
| human merge (GitHub) | `waiting_for_human` | `merged` |
| `/factory approve <job-id>` from an approver `ESCALATE` | `approval` / `needs-human` | `publication` / `active` (human action recorded) |
| `/factory rework <job-id> <note>` from a human escalation | `review` or `approval` / `needs-human` | `build` / `active`, round + 1 (closed round retained) |
| `/factory retry <job-id>` | any stage / `blocked` | same stage / `active` |
| `/factory cancel <job-id>` | any non-terminal state | same stage / `cancelled` |
| `/factory promote <job-id> [main or master]` | `waiting_for_human` / `needs-human` with a PR | same state, promotion PR recorded |
| `/factory recover` | any job whose durable evidence disagrees with the board | the last safe durable stage (event `recovered`) |

Invalid transitions are rejected without mutating state: an operator command
that is not eligible throws `CommandNotEligibleError` and the board is left
exactly as it was.

## Operator commands

Operator commands are guarded transitions owned by the extension. They never
delete history, artifacts, branches, worktrees, or PRs, and none of them merges.

- **approve** only resolves an approver `ESCALATE` at the approval gate. It
  records the human action and moves the job to `publication`/`active`. It cannot
  override a review-exhaustion escalation, which requires an explicit `rework`.
- **rework** is only eligible while the job is `needs-human` at `review`
  (round limit reached) or `approval` (approver escalated). It retains the
  closed round's plan and evidence, increments `round`, clears `review_plan`,
  and returns the job to `build`/`active`. The required operator note is appended
  to `history` and `events.jsonl` and handed to the resumed builder.
- **retry** is only eligible for a `blocked` job, which the factory reserves for
  recoverable contention or external failure. `needs-human` is never retried:
  automation must not guess.
- **promote** is only eligible once a job is published and awaiting its human
  merge. It prepares (or reuses) a promotion PR from the job's integration branch
  to a protected branch and records it on the job. The factory never merges it
  and never changes branch protection.
- **cancel** is eligible for any non-terminal job. It records the operator note,
  stops active child work where a host provides a stopper, and sets `cancelled`.
  It preserves every artifact, the branch, the worktree, and any PR.

The `round` on a `human_rework` event is the round being closed, so the new
build runs in round + 1.

`policy.limits.max_review_rounds` bounds the **total number of review rounds**,
not the number of reworks. A blocking finding in the last permitted round has no
next round to open, so it escalates to `needs-human` instead.

## Restart recovery

`/factory recover` reconciles every job against its durable evidence: the job
artifacts on disk, Git, and GitHub. It runs under a recovery lock, records one
`recovered` history/event entry per changed job, and never deletes anything.

- **Resume from the last safe durable stage.** A stage whose required evidence
  is complete is safe; a stage whose evidence is gone resumes at the last stage
  that is still supported. Missing `spec.md` resumes at `spec`; missing
  `build.md` resumes at `build`; a missing current-round report resumes at
  `review` — but only when no verdict was recorded for it. A verdict recorded
  for a report that cannot be read is a disagreement and escalates to
  `needs-human` instead.
- **Disagreement escalates.** When the board and the evidence contradict each
  other (a verdict without a readable report, an approval without
  `decision.md`, a missing branch, a recorded PR that GitHub does not know),
  recovery sets `needs-human` instead of guessing. The durable decision
  artifact always wins: a `decision.md` recording `APPROVE` restores a lost
  board approval, and one recording `ESCALATE` returns the job to the approver
  gate even if the board claims approval.
- **GitHub is the merge authority.** A `waiting_for_human` job whose recorded
  PR is merged on GitHub becomes `merged`; anything else that disagrees
  (missing, closed, or not found) stays or becomes `needs-human`. Check-run
  results are deliberately not consulted: the factory never auto-merges, so
  checks cannot change any automatable transition — they are part of the
  human merge decision.
- **Deliberate states are untouched.** Terminal (`merged`, `cancelled`),
  `blocked`, and `failed` jobs — and `needs-human` jobs below the publication
  gate — were written by a guarded transition or a recorded factory stop; only
  an operator command changes them. At the publication gate, GitHub evidence
  may still complete a `needs-human` job whose PR was merged.
- **Recovery starts no work.** A restart cannot duplicate job starts because
  recovery only reconciles recorded state: it allocates no job ids, launches
  no roles, and re-runs no stages. Duplicate job ids on a hand-edited board
  fail closed in the board parser.
- **No-op recoveries write nothing.** When every job already matches its
  evidence, the board is not rewritten and no events are appended.

## Concurrency

- Board writes run under a cross-process board lock, are guarded by the
  monotonic `version` counter, and are swapped in atomically. A writer that
  analyzed state which changed underneath it fails closed with
  `StaleBoardError` instead of recording stale results.
- Each job's branch is a shared resource: worktree/branch creation in the
  build stage and the publication push both run under the job's
  `.branch.lock`. Contention there is reported (`LockTimeoutError`) and leaves
  the job untouched, so a live owner is never blocked by a reporter.
- Promotion runs under both the job's `.promotion.lock` and a per-target
  `.promotion-<target>.lock` (always acquired in that order), so two jobs
  cannot prepare promotions to the same protected branch concurrently.
