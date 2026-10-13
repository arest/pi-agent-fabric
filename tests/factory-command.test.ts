import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { factoryPaths } from "../src/state/paths.ts";
import { startJob } from "../src/workflow/start-job.ts";
import {
  boardPath,
  completeSpecMarkdown,
  createHarness,
  jobSpecPath,
  makeTempRepo,
  readBoard,
  readJobEvents,
  removeTempRepo,
} from "./helpers/harness.ts";

test("startJob stamps every timestamp from the injected clock", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const fixed = new Date("2026-10-12T10:30:00.000Z");
  const { job } = await startJob({ cwd, feature: "Deterministic clock", now: () => fixed });

  assert.equal(job.created_at, fixed.toISOString());
  assert.equal(job.updated_at, fixed.toISOString());
  assert.equal(job.history[0]?.at, fixed.toISOString());

  const events = await readJobEvents(cwd, job.id);
  assert.equal(events[0]?.at, fixed.toISOString());
  assert.equal(events[0]?.job_id, job.id);
});

test("/factory is registered as a command", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  const command = harness.commands.get("factory");

  assert.ok(command, "expected the extension to register /factory");
  assert.match(command.description ?? "", /feature/i);
});

test("missing policy uses safe defaults and records the effective policy", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const { job } = await startJob({ cwd, feature: "Default policy" });

  assert.equal(job.mode, "develop");
  assert.equal(job.target, "develop");
  assert.deepEqual(job.policy, { v: 1, source: "default", mode: "develop", target: "develop" });
});

test("a valid repository policy is loaded before starting a job", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".pi", "factory.json"),
    JSON.stringify({
      schema_version: 1,
      target_mode: "develop",
      reviewers: { available: ["code"], required: ["code"], selection: "orchestrator" },
      limits: { max_review_rounds: 3, max_jobs_per_batch: 10 },
      github: { adapter: "gh", auto_merge: false },
      promotion: { develop: { human_merge_required: true } },
    }),
  );

  const { job } = await startJob({ cwd, feature: "Configured policy" });
  assert.equal(job.mode, "develop");
  assert.equal(job.target, "develop");
  assert.deepEqual(job.policy, { v: 1, source: "repo", mode: "develop", target: "develop" });
});

test("invalid or unsafe policy fails closed before any side effect", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".pi", "factory.json"), JSON.stringify({ schema_version: 1, target_mode: "aggregator" }));

  const harness = createHarness(cwd);
  await harness.run("factory", "Unsafe policy");

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.type, "error");
  assert.match(harness.notifications[0]?.message ?? "", /target_mode/i);
  await assert.rejects(fs.access(path.join(cwd, "factory")));
});

test("unsafe configured commands are rejected before startup", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".pi", "factory.json"),
    JSON.stringify({ schema_version: 1, repository: { test_commands: [{ name: "all", command: "npm test; rm -rf /" }] } }),
  );

  await assert.rejects(startJob({ cwd, feature: "Unsafe command" }), /unsafe shell syntax/);
  await assert.rejects(fs.access(boardPath(cwd)));
});

test("malformed policy fails closed without creating a board", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".pi", "factory.json"), "{ not json");

  await assert.rejects(startJob({ cwd, feature: "Malformed policy" }), /not valid JSON/);
  await assert.rejects(fs.access(boardPath(cwd)));
});

test("starting a job seeds a durable board entry and job scaffold", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await harness.run("factory", "Add rate limiting to the public API");

  const board = await readBoard(cwd);
  assert.equal(board.schema_version, 1);
  assert.equal(board.version, 1);
  assert.equal(board.jobs.length, 1);

  const job = board.jobs[0];
  assert.equal(job.id, "001-add-rate-limiting-to-the-public-api");
  assert.equal(job.feature, "Add rate limiting to the public API");
  assert.equal(job.mode, "develop");
  assert.equal(job.branch, "factory/001-add-rate-limiting-to-the-public-api");
  assert.equal(job.target, "develop");
  assert.equal(job.stage, "spec");
  assert.equal(job.status, "active");
  assert.equal(job.round, 1);

  assert.equal(job.history.length, 1);
  assert.deepEqual(job.history[0], {
    at: job.history[0].at,
    from: null,
    to: "spec",
    actor: "factory",
    event: "job_created",
    round: 1,
  });

  // No reviewer selection, verdict, or publication flow exists yet.
  assert.equal(job.review_plan, null);
  assert.deepEqual(job.verdicts, {});
  assert.equal(job.pull_request, null);

  const events = await readJobEvents(cwd, job.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "job_created");
  assert.equal(events[0].job_id, job.id);
  assert.equal(events[0].to, "spec");

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].type, "info");
  assert.match(harness.notifications[0].message, /001-add-rate-limiting-to-the-public-api/);
});

test("concurrent starts allocate distinct sequential job ids", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await Promise.all([harness.run("factory", "Alpha feature"), harness.run("factory", "Beta feature")]);

  // The lock guarantees distinct sequential ids; which request wins the race
  // is not deterministic, so assert on the sequence numbers and features.
  const board = await readBoard(cwd);
  assert.equal(board.version, 2);
  assert.deepEqual(
    [...board.jobs.map((job) => Number(job.id.slice(0, 3)))].sort((a, b) => a - b),
    [1, 2],
  );
  assert.deepEqual([...board.jobs.map((job) => job.feature)].sort(), ["Alpha feature", "Beta feature"]);
  for (const job of board.jobs) {
    assert.match(job.id, /^\d{3}-[a-z0-9-]+$/);
    assert.equal(job.branch, `factory/${job.id}`);
  }
});

test("an empty feature request is rejected without side effects", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await harness.run("factory", "   ");

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].type, "warning");
  assert.match(harness.notifications[0].message, /usage/i);
  await assert.rejects(fs.access(boardPath(cwd)), "board.json must not be created");
});

test("feature text cannot escape the job id or branch namespace", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await harness.run("factory", "../../etc/passwd; rm -rf /");

  const board = await readBoard(cwd);
  const job = board.jobs[0];
  assert.match(job.id, /^\d{3}-[a-z0-9-]+$/);
  assert.ok(!job.id.includes(".."));
  assert.ok(!job.id.includes("/"));
  assert.equal(job.branch, `factory/${job.id}`);
});

test("reserved operator subcommands are refused instead of becoming a job", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  for (const verb of ["next", "approve", "rework", "retry", "promote", "cancel"]) {
    await harness.run("factory", `${verb} 001-some-job`);
  }

  assert.equal(harness.notifications.length, 6);
  for (const notification of harness.notifications) {
    assert.equal(notification.type, "warning");
    assert.match(notification.message, /not available yet/);
  }
  await assert.rejects(fs.access(boardPath(cwd)), "no job may be created for a reserved subcommand");
});

test("a failed artifact write rolls back the job directory", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const paths = factoryPaths(cwd);
  await fs.mkdir(paths.jobsDir, { recursive: true });
  await fs.writeFile(paths.boardFile, JSON.stringify({ schema_version: 1, version: 1, jobs: [] }));

  // Deterministic fault injection: plant a directory where the job event log
  // must land, so the atomic rename cannot complete after the job directory has
  // been created. No permissions or clock racing required.
  const blockedJobDir = path.join(paths.jobsDir, "001-rollback-feature");
  await fs.mkdir(path.join(blockedJobDir, "events.jsonl"), { recursive: true });
  await fs.writeFile(path.join(blockedJobDir, "events.jsonl", "keep"), "");

  const harness = createHarness(cwd);
  await harness.run("factory", "Rollback feature");

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].type, "error");
  assert.deepEqual(await fs.readdir(paths.jobsDir), [], "the partial job directory must be removed");
  await assert.rejects(fs.access(path.join(paths.jobsDir, "events.jsonl")));

  const board = JSON.parse(await fs.readFile(paths.boardFile, "utf8")) as { version: number; jobs: unknown[] };
  assert.equal(board.version, 1, "the board must be left untouched when the job cannot be written");
  assert.deepEqual(board.jobs, []);
});

test("/factory spec without a job id reports usage and creates nothing", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await harness.run("factory", "spec");

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].type, "warning");
  assert.match(harness.notifications[0].message, /usage/i);
  await assert.rejects(fs.access(boardPath(cwd)), "a spec invocation must never be treated as a feature request");
});

test("feature text that merely starts with spec still starts a job", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await harness.run("factory", "spec cleanup of request logs");

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].type, "info");
  const board = await readBoard(cwd);
  assert.equal(board.jobs.length, 1);
  assert.equal(board.jobs[0].feature, "spec cleanup of request logs");
  assert.equal(board.jobs[0].stage, "spec");
});

test("a single non-job-id argument after spec warns instead of starting a job", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await harness.run("factory", "spec 12-not-a-real-id");

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].type, "warning");
  assert.match(harness.notifications[0].message, /not a job id/i);
  await assert.rejects(fs.access(boardPath(cwd)), "a malformed job id must not start a job");
});

test("/factory spec scaffolds the artifact and refuses to advance an empty spec", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await harness.run("factory", "Add rate limiting to the public API");
  const jobId = (await readBoard(cwd)).jobs[0].id;

  await harness.run("factory", `spec ${jobId}`);

  const errors = harness.notifications.filter((notification) => notification.type === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /missing/i);
  assert.match(errors[0].message, /Problem/);

  const spec = await fs.readFile(jobSpecPath(cwd, jobId), "utf8");
  assert.match(spec, /^## Problem$/m, "the stage must scaffold the spec-writer artifact");

  const board = await readBoard(cwd);
  assert.equal(board.jobs[0].stage, "spec", "an incomplete spec must not advance the job");
  const events = await readJobEvents(cwd, jobId);
  assert.deepEqual(events.map((event) => event.event), ["job_created"]);
});

test("/factory spec advances the job to build once the contract is complete", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await harness.run("factory", "Add rate limiting to the public API");
  const jobId = (await readBoard(cwd)).jobs[0].id;

  await fs.writeFile(jobSpecPath(cwd, jobId), completeSpecMarkdown(), "utf8");
  await harness.run("factory", `spec ${jobId}`);

  assert.equal(harness.notifications.length, 2);
  assert.equal(harness.notifications[1].type, "info");
  assert.match(harness.notifications[1].message, /advanced to stage build/i);

  const board = await readBoard(cwd);
  assert.equal(board.jobs[0].stage, "build");
  assert.equal(board.jobs[0].history.at(-1)?.event, "spec_complete");

  const events = await readJobEvents(cwd, jobId);
  assert.deepEqual(events.map((event) => event.event), ["job_created", "spec_complete"]);
});

test("/factory spec reports an unknown job without creating one", async (t) => {
  const cwd = await makeTempRepo();
  t.after(() => removeTempRepo(cwd));

  const harness = createHarness(cwd);
  await harness.run("factory", "spec 001-missing-job");

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].type, "error");
  assert.match(harness.notifications[0].message, /no factory job/i);
  await assert.rejects(fs.access(boardPath(cwd)));
});
