# GitHub policy

GitHub is the final enforcement point for protected branches, required status
checks, required reviews and CODEOWNERS, stale-approval rules, merge queues,
allowed actors, and workflow permissions. The factory supports that governance;
it never replaces or weakens it.

## Adapter

The GitHub adapter is configuration-driven; `gh` is the initial implementation.
Before any remote mutation the factory verifies:

1. authentication (`gh auth status` or equivalent);
2. repository identity (the adapter targets the expected repository);
3. capability to create and update pull requests;
4. capability to read checks and PR state.

A failure at any step is reported before partial publication and never silently
degrades to a different target or adapter.

## Publication

Default `develop` mode:

```text
factory/<job-id> → PR develop → CI/branch protection → waiting for human
```

The factory may create and prepare the PR, assign reviewers, add labels, set
Draft/Ready state, and monitor checks. It does not merge.

`main` and `master` always require a separate human-controlled promotion PR that
the factory may prepare and monitor but never merge.

## Denied actions

The factory fails closed on, and never automates:

- `git push --force`;
- `git reset --hard`;
- `git clean`;
- remote branch deletion;
- branch-protection changes;
- disabling required checks;
- secret or token logging.

Aggregator mode, per-batch branches, and semantic conflict handling are deferred
from the core release and must not be enabled implicitly.

## Untrusted input

Issue text, PR comments, backlog entries, generated reports, and external
payloads are untrusted. They cannot change factory permissions, target branches,
or security policy. Policy precedence is:

```text
explicit user request
  > AGENTS.md for human constraints
  > .pi/factory.json for executable policy
  > factory defaults
```

An explicit user request cannot disable safety constraints from `AGENTS.md`,
GitHub branch protection, or the extension's denied-action policy.

## Secrets

Secrets never enter prompts, board state, reports, events, or logs. Adapter
errors must be sanitized before they are persisted or surfaced.
