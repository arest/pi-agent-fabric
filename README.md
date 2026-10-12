# pi-agent-fabric

A reusable Pi package that turns a feature request into a reviewed pull request
while keeping the merge human-controlled.

The package ships:

- a Pi **extension** that owns the `/factory` command and is the only writer of
  durable factory state;
- a Pi **skill** that documents the workflow, role contracts, and GitHub policy.

## Status

Bootstrap slice: `/factory <feature>` validates repository policy and creates a
new job scaffold. Later tickets add the spec-writer, builder, reviewers,
approver, GitHub publication, operator commands, crash recovery, and the
read-only dashboard.

```text
/factory <feature>   start a job scaffold (implemented)
```

All other `/factory` subcommands are not implemented yet and report that they
are unavailable.

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
defaults apply. The job starts at stage `spec` with status `active`; reviewer
and approval flow are added by later tickets.

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
