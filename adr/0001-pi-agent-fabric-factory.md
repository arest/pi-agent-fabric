# Pi Agent Fabric Factory

Status: accepted

## Context

The repository needs a small, auditable workflow for turning feature requests
into reviewed changes. The initial concept was written for Claude Code, but the
repository workflow is being designed for the Pi coding agent and must respect
protected GitHub branches.

## Decision

The Agent Fabric Factory will become a standalone reusable Pi package rather
than a repository-local Claude Code workflow. A bundled Pi skill provides
workflow guidance, while a Pi extension is the only writer of durable factory
state. Pi subagents implement stable roles such as builder, reviewer, and
approver; their providers and models remain configurable.

Reviewers and the approver are read-only against application code. The default
publication target is a human-merged PR to `develop`, with an optional
per-batch aggregator branch. `main` and `master` always require separate
human-controlled promotion. GitHub branch protection remains the final trust
boundary.

## Consequences

The workflow is provider-neutral within Pi, recovery is auditable, and unsafe
direct merges are avoided. The extension must implement atomic state writes,
locks, configuration validation, and fail-closed dangerous-command handling.
The design also requires explicit contracts for reviewer selection, WAIT FOR
ALL, crash recovery, and human escalation.

Repository-specific branch rules, test commands, commit conventions, and
migration policies remain outside the package in a validated `.pi/factory.json`
policy layer. The first core release uses the default `develop` PR flow; batch
aggregation is an optional later module rather than a core assumption.

## Alternatives considered

- **Claude Code-specific skills and agents:** rejected because the target runtime
  is Pi and the repository must not depend on Claude-specific conventions.
- **Direct merges from the orchestrator:** rejected because protected branches
  and human review must remain enforceable by GitHub.
- **LLM-owned board state:** rejected because concurrent jobs and recovery need
  serialized, validated, atomic updates owned by the extension.
- **Mandatory reviewers for every feature:** rejected because reviewer roles
  should be selected from the feature's actual risk and scope.
- **Repository-local implementation:** rejected because the workflow should be
  reusable across projects and independently versioned.
- **Aggregator in the first core release:** deferred because batch integration
  has different conflict and trust behavior from the basic job-to-PR flow.
