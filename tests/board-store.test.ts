import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { BoardIntegrityError } from "../src/state/board.ts";
import { BoardStore, StaleBoardError } from "../src/state/board-store.ts";
import { acquireLock, LockTimeoutError } from "../src/state/lock.ts";
import { factoryPaths } from "../src/state/paths.ts";
import { makeTempRepo, removeTempRepo } from "./helpers/harness.ts";

test("mutations are atomic, versioned, and leave no temp files behind", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const store = new BoardStore(cwd);
  const first = await store.mutate((board) => {
    board.jobs.push(makeJob("001-first"));
    return "first";
  });

  assert.equal(first.result, "first");
  assert.equal(first.board.version, 1);

  const entries = await fs.readdir(store.paths.factoryDir);
  assert.deepEqual(entries.sort(), ["board.json"]);
});

test("concurrent mutations serialize without losing updates", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const store = new BoardStore(cwd);
  await Promise.all([
    store.mutate((board) => {
      board.jobs.push(makeJob("001-alpha"));
    }),
    store.mutate((board) => {
      board.jobs.push(makeJob("002-beta"));
    }),
  ]);

  const board = await store.read();
  assert.equal(board.version, 2);
  assert.deepEqual(
    [...board.jobs.map((job) => job.id)].sort(),
    ["001-alpha", "002-beta"],
  );
});

test("a stale expected version is rejected without writing", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const store = new BoardStore(cwd);
  const { board: stale } = await store.mutate((board) => {
    board.jobs.push(makeJob("001-first"));
  });

  await store.mutate((board) => {
    board.jobs.push(makeJob("002-second"));
  });

  await assert.rejects(
    store.mutate(
      (board) => {
        board.jobs.push(makeJob("003-third"));
      },
      { expectedVersion: stale.version },
    ),
    StaleBoardError,
  );

  const board = await store.read();
  assert.equal(board.version, 2);
  assert.deepEqual(
    board.jobs.map((job) => job.id),
    ["001-first", "002-second"],
  );
});

test("history and prior jobs are preserved across writes", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const store = new BoardStore(cwd);
  await store.mutate((board) => {
    board.jobs.push(makeJob("001-first"));
  });
  await store.mutate((board) => {
    const job = board.jobs[0];
    job.history.push({ at: nowForTest(), from: "spec", to: "build", actor: "factory", event: "spec_complete" });
    job.stage = "build";
    job.updated_at = nowForTest();
  });

  const board = await store.read();
  assert.equal(board.version, 2);
  assert.equal(board.jobs[0].stage, "build");
  assert.deepEqual(
    board.jobs[0].history.map((entry) => entry.event),
    ["job_created", "spec_complete"],
  );
});

test("an invalid board fails closed rather than being overwritten", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const paths = factoryPaths(cwd);
  await fs.mkdir(paths.factoryDir, { recursive: true });
  await fs.writeFile(paths.boardFile, "{ not json");

  const store = new BoardStore(cwd);
  await assert.rejects(store.read(), BoardIntegrityError);
  await assert.rejects(
    store.mutate((board) => {
      board.jobs.push(makeJob("001-first"));
    }),
    BoardIntegrityError,
  );

  assert.equal(await fs.readFile(paths.boardFile, "utf8"), "{ not json");
});

test("an unknown board schema version fails closed", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const paths = factoryPaths(cwd);
  await fs.mkdir(paths.factoryDir, { recursive: true });
  await fs.writeFile(
    paths.boardFile,
    JSON.stringify({ schema_version: 999, version: 4, jobs: [] }),
  );

  const store = new BoardStore(cwd);
  await assert.rejects(store.read(), BoardIntegrityError);
});

test("a held lock blocks a second writer until it is released", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const lockPath = path.join(cwd, "factory", ".board.lock");
  const held = await acquireLock(lockPath);
  await assert.rejects(
    acquireLock(lockPath, { timeoutMs: 120, pollMs: 10 }),
    LockTimeoutError,
  );
  await held.release();
  const reacquired = await acquireLock(lockPath, { timeoutMs: 120, pollMs: 10 });
  await reacquired.release();
});

test("an abandoned lock is reclaimed", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const lockPath = path.join(cwd, "factory", ".board.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, acquired_at: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(lockPath, old, old);

  const lock = await acquireLock(lockPath, { timeoutMs: 200, pollMs: 10, staleMs: 1_000 });
  await lock.release();
});

test("a lock held by a live process is never reclaimed, however old", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const lockPath = path.join(cwd, "factory", ".board.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  // Claim the lock as the running test process, with an ancient mtime.
  await fs.writeFile(lockPath, JSON.stringify({ token: "other", pid: process.pid }));
  const old = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(lockPath, old, old);

  await assert.rejects(
    acquireLock(lockPath, { timeoutMs: 120, pollMs: 10, staleMs: 1 }),
    LockTimeoutError,
  );
  assert.ok(await fs.stat(lockPath).then(() => true), "the live holder's lock must survive");
});

test("releasing a lock another process reclaimed does not steal it", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const lockPath = path.join(cwd, "factory", ".board.lock");
  const original = await acquireLock(lockPath, { timeoutMs: 200, pollMs: 10 });

  // Simulate a reclaimer taking over while the original holder is stalled.
  await fs.writeFile(lockPath, JSON.stringify({ token: "usurper", pid: process.pid }));
  await original.release();

  const stillHeld = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token?: string };
  assert.equal(stillHeld.token, "usurper", "the new owner's lock must not be deleted");
});

test("a board whose history omits the optional event field still parses", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const paths = factoryPaths(cwd);
  await fs.mkdir(path.dirname(paths.boardFile), { recursive: true });
  const stored = makeJob("001-bare");
  const bareHistory = { at: stored.created_at, from: null, to: "spec" as const, actor: "factory" };
  await fs.writeFile(
    paths.boardFile,
    JSON.stringify({
      schema_version: 1,
      version: 1,
      jobs: [{ ...stored, history: [bareHistory] }],
    }),
  );

  const board = await new BoardStore(cwd).read();
  assert.equal(board.jobs.length, 1);
  assert.equal(board.jobs[0]?.history[0]?.event, undefined);
});

function nowForTest(): string {
  return new Date().toISOString();
}

function makeJob(id: string) {
  const at = nowForTest();
  return {
    id,
    feature: `feature ${id}`,
    mode: "develop" as const,
    branch: `factory/${id}`,
    target: "develop",
    stage: "spec" as const,
    status: "active" as const,
    round: 1,
    review_plan: null,
    verdicts: {},
    pull_request: null,
    created_at: at,
    updated_at: at,
    history: [{ at, from: null, to: "spec" as const, actor: "factory", event: "job_created" }],
  };
}
