# Agent guidance

This repository is the Agent Fabric Factory: a reusable Pi package that turns a
feature request into a reviewed pull request. Read
`BUILD_PROMPT_FOR_AGENT_FABRIC_FACTORY.md` (design brief) and
`adr/0001-pi-agent-fabric-factory.md` before starting work.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `arest/pi-agent-fabric`, via the `gh`
CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, each label string equal to its role name:
`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root, ADRs under `adr/`. See
`docs/agents/domain.md`.
