# [M2] Pre-existing factory symlinks redirect durable writes

## Summary
The factory follows pre-existing symlinks in its repository-local state tree. A local unprivileged process or a contributor who can prepare the checkout can replace `factory/jobs` (or another factory parent) with a symlink to a writable directory. When an operator starts a job, the factory writes job events and other durable state through that symlink, outside the intended repository root. The finding was reproduced against the real `startJob` implementation; PoC status: **executed**.

**Severity:** Medium  
**CWE:** CWE-22 (improper limitation of a pathname to a restricted directory)

## Details

`factoryPaths` resolves the configured checkout and then constructs state paths with ordinary `path.join`. It does not resolve or inspect existing filesystem components, and it does not enforce that the final real path remains below the checkout:

```ts
const root = path.resolve(cwd);
const factoryDir = path.join(root, "factory");
return {
  root,
  factoryDir,
  boardFile: path.join(factoryDir, "board.json"),
  boardLockFile: path.join(factoryDir, ".board.lock"),
  jobsDir: path.join(factoryDir, "jobs"),
  worktreesDir: path.join(factoryDir, "worktrees"),
};
```

This path construction is visible in [`src/state/paths.ts`](https://github.com/arest/pi-agent-fabric/blob/7491206657accbfa06cbf56e5b4ee453ee28620b/src/state/paths.ts#L24-L38). The generated job identifier is a safe slug, so this is not dependent on `../` traversal or a malicious feature string. The attack instead changes the directory topology before the factory runs.

During job creation, [`src/workflow/start-job.ts`](https://github.com/arest/pi-agent-fabric/blob/7491206657accbfa06cbf56e5b4ee453ee28620b/src/workflow/start-job.ts#L58-L83) derives the job directory and recursively creates it:

```ts
const id = allocateJobId(draft, feature);
const dir = jobDir(paths, id);

await fs.mkdir(dir, { recursive: true });
createdDir = dir;

await appendJobEvent(paths, id, jobCreated);
```

Node's recursive `mkdir` and subsequent file operations follow a pre-existing symlink in `factory/jobs`. The same unchecked derived paths are used for board mutation and locking: [`src/state/board-store.ts`](https://github.com/arest/pi-agent-fabric/blob/7491206657accbfa06cbf56e5b4ee453ee28620b/src/state/board-store.ts#L73-L83) acquires the board lock and atomically writes the board, while [`src/state/atomic-write.ts`](https://github.com/arest/pi-agent-fabric/blob/7491206657accbfa06cbf56e5b4ee453ee28620b/src/state/atomic-write.ts#L13-L25) creates temporary files and renames them through the derived parent. [`src/state/lock.ts`](https://github.com/arest/pi-agent-fabric/blob/7491206657accbfa06cbf56e5b4ee453ee28620b/src/state/lock.ts#L101-L108) likewise creates the lock parent recursively without rejecting symlinks. None of these paths performs `lstat`, `realpath` containment, or an ownership/no-symlink check.

## Root Cause

The factory treats lexical paths beneath `cwd` as equivalent to filesystem paths beneath `cwd`. That assumption is false when an attacker can prepare a symlinked parent before execution. Existing slug validation protects against malformed job IDs, and exclusive lock creation plus atomic replacement protect concurrent writes, but those controls operate after path resolution and therefore do not establish the intended repository-state boundary.

## Proof of Concept (PoC)

The runnable PoC is [`piolium/findings/M2-factory-symlink-path-escape/poc.js`](piolium/findings/M2-factory-symlink-path-escape/poc.js). It performs the following shortest reproduction:

1. Create a temporary checkout and a separate attacker-controlled writable directory.
2. Create `checkout/factory` and make `checkout/factory/jobs` a symlink to the separate directory.
3. Invoke the actual `src/workflow/start-job.ts` `startJob({ cwd: checkout, feature: "symlink escape proof" })` implementation.
4. Resolve the resulting `events.jsonl` with `realpath` and verify its contents include the newly allocated job ID.

The PoC completed successfully with exit status 0. The captured execution environment records the result as confirmed: the job's `events.jsonl` resolved outside the temporary checkout. The decisive check in the PoC is:

```js
const event = await fs.readFile(escapedEvents, "utf8");
const escapedOutsideRoot = (await fs.realpath(escapedEvents)).startsWith(`${root}${path.sep}`) === false;

console.log(JSON.stringify({
  status: escapedOutsideRoot && event.includes(`"job_id":"${result.job.id}"`) ? "confirmed" : "failed",
}));
```

This demonstrates an actual durable job event written through the pre-existing `factory/jobs` symlink, not merely a theoretical path calculation.

## Impact

An attacker who can prepare or modify the checkout's factory directory before an operator invokes the factory can redirect job artifacts and events to an attacker-selected location, subject to filesystem permissions. Depending on which factory parent is replaced, the same weakness can redirect board state, lock files, temporary files, review artifacts, or worktree-related state. This can cause integrity loss, disclosure of factory data, denial of service, and cross-project state confusion. The PoC demonstrates the event-write integrity boundary being crossed; broader consequences depend on the deployment's permissions and which state path is redirected.

The issue does not require an HTTP request or an authenticated application role. It requires local filesystem influence over the checkout before factory execution, such as an untrusted contributor-controlled checkout, shared workspace, or another local process able to create the symlink.

## Remediation

Before using any factory-owned path, validate the filesystem topology rather than only the lexical pathname. Recommended safeguards are:

- Reject symlinks in every existing component from the repository root through the factory-owned parent directories, using `lstat`/`realpath` checks appropriate to the platform.
- Verify that the resolved target remains beneath the expected repository root and, where applicable, that factory directories are owned by the expected user.
- Create the factory directory hierarchy with restrictive permissions and validate it before each durable write, including board, lock, event, artifact, and temporary-file paths.
- Avoid relying on `mkdir({ recursive: true })` as a security boundary: it creates missing components but does not make pre-existing symlinked parents safe.
- Add regression tests covering symlinked `factory`, `factory/jobs`, and other durable-state parents, asserting that startup fails closed and performs no redirected write.
