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

Invalid transitions are rejected without mutating state. Later tickets
(`approve`, `rework`, `retry`, `promote`, `cancel`) add operator-driven
transitions with their own eligibility guards.

`policy.limits.max_review_rounds` bounds the **total number of review rounds**,
not the number of reworks. A blocking finding in the last permitted round has no
next round to open, so it escalates to `needs-human` instead.
