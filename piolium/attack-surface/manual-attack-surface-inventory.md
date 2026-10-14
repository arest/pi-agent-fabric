# Manual Attack-Surface Inventory (L4)

Generated: 2026-10-14

## Selected slices

1. **Repository policy → validation subprocess** (highest-impact command/process boundary).
2. **Host cwd / job identifiers → factory filesystem** (filesystem and symlink boundary).

## Entry points

- `extensions/factory.ts:205-264` — registered `/factory` command; accepts feature text and subcommands (`spec`, `recover`, `approve`, `rework`, `retry`, `promote`, `cancel`) plus job IDs and notes.
- `src/workflow/start-job.ts:43-104` — `startJob({cwd, feature})`; creates durable job state from host-provided cwd and operator feature input.
- `src/workflow/build-stage.ts:87-188` — `runBuildStage`; reaches repository-configured validation commands in the prepared worktree.
- `src/config/policy.ts:168-187` — `loadPolicy(cwd)`; reads `.pi/factory.json` from the repository.
- `src/workflow/publication/gh-adapter.ts:30-111` — publication preflight and push/PR calls through local `git`/`gh`.
- `factory/dashboard.html` — optional static browser entry point; no server route is implemented here.

## Public routes / URLs

- No inbound HTTP API, URL router, middleware stack, WebSocket, or server is implemented in this repository.
- Pi host command route: `/factory` (host-local command surface, not an HTTP URL).
- Optional dashboard asset URL is deployment-defined; the page fetches same-origin `board.json?ts=...` and local `jobs/...` artifacts. GitHub PR URLs are external outputs.

## Attacker sources

- Malicious/compromised repository contributor controlling `.pi/factory.json`, source/build/test files, and checkout symlink topology.
- Local unprivileged process/user able to modify the checkout or `factory/` tree while the extension runs, including `PATH`, Git config, and `gh` context.
- Feature/spec/review/notes content supplied through `/factory` or durable artifacts.
- Anonymous reader only if an operator exposes the static dashboard directory without server-side access control.

## Sinks

- `src/workflow/build-stage.ts:271-284` — `execFileAsync(executable, parts, {cwd, maxBuffer})`; runs policy-selected executable and arguments with inherited environment and local user privileges.
- `src/workflow/build-stage.ts:50-67` — local `git worktree add`; executes Git in the host repository.
- `src/workflow/start-job.ts:58-63` — `fs.mkdir` under `factory/jobs/<job-id>`; follows pre-existing directory/symlink components.
- `src/state/board-store.ts:73-83` and `src/state/atomic-write.ts:13-25` — board lock/write and atomic rename under paths derived from cwd; no symlink/ownership verification is performed in these functions.
- `src/workflow/publication/gh-adapter.ts:30-111` — authenticated `gh` queries and `git push`, with repository identity checks but external credential/context reliance.
- `factory/dashboard.html` — browser DOM/URL rendering; the knowledge base records `textContent` and URL restrictions as controls.

## Hidden control channels

- Host-supplied `ExtensionCommandContext.cwd` selects the repository root and therefore every policy, board, artifact, and worktree path.
- `.pi/factory.json` selects validation executable/arguments, reviewer settings, and limits; it is repository-controlled input.
- `PATH`, `HOME`, Git config, `gh` auth/config, and current remote identity influence subprocess behavior.
- Existing symlinks, permissions, and concurrent local processes in `factory/` influence path resolution and lock behavior.
- Board/artifact state, lock files, Git refs, and GitHub JSON responses control stage eligibility and publication decisions.
- No request headers, proxy headers, tenant selectors, method overrides, cache keys, debug/admin headers, or server-side sessions exist in this codebase.

## Middleware / proxy assumptions

There is no application middleware or reverse proxy. Security assumes the Pi host supplies the intended cwd and trusted command invocation context. If `factory/` is served by a consumer-chosen static server, access control is outside this repository; dashboard JavaScript restrictions are not server authorization.

## Key files

- `extensions/factory.ts` — command registration and dispatch.
- `src/config/policy.ts` — repository policy parser and shell-metacharacter rejection.
- `src/workflow/build-stage.ts` — worktree preparation and validation process execution.
- `src/workflow/start-job.ts` — job creation and artifact directory creation.
- `src/state/paths.ts` — cwd/job-derived filesystem paths.
- `src/state/board-store.ts`, `src/state/atomic-write.ts`, `src/state/lock.ts` — durable state, atomic writes, and lock files.
- `src/workflow/gh.ts`, `src/workflow/publication/gh-adapter.ts` — local process and GitHub publication boundary.
- `factory/dashboard.html` — optional static presentation surface.
