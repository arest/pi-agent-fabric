import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { runReviewStage, ReviewIncompleteError, type Reviewer } from "../src/workflow/review-stage.ts";
import { startJob } from "../src/workflow/start-job.ts";
import { runSpecStage } from "../src/workflow/spec-stage.ts";
import { runBuildStage, type Builder, type WorktreeProvider } from "../src/workflow/build-stage.ts";
import { acquireLock } from "../src/state/lock.ts";
import { completeSpecMarkdown, makeTempRepo, readBoard, readJobEvents, removeTempRepo } from "./helpers/harness.ts";
import path from "node:path";

const NOW = (): Date => new Date("2026-02-03T04:05:06.000Z");
const provider = (cwd: string): WorktreeProvider => ({ prepare: async () => ({ path: cwd, lockPath: path.join(cwd, "builder.lock") }) });
const builder: Builder = async ({ buildFile }) => fs.writeFile(buildFile, "## Changed files\n\n- src/example.ts\n\n## Validation\n\n- PASS\n\n## Remaining risks\n\nNone\n");
const passReviewer: Reviewer = async ({ reportFile, role }) => fs.writeFile(reportFile, `# ${role}\n\nVERDICT: PASS\nSEVERITY: NON-BLOCKING\n\n## Summary\n\nLooks good.\n\n## Findings\n\nNone.\n\n## Evidence\n\nInspected diff.\n\n## Recommendations\n\nNone.\n`);

async function seedReview(cwd: string): Promise<string> {
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  try { await fs.access(path.join(cwd, ".pi", "factory.json")); } catch { await fs.writeFile(path.join(cwd, ".pi", "factory.json"), JSON.stringify({ schema_version: 1, reviewers: { available: ["security", "code", "ui"], required: [] } })); }
  const { job } = await startJob({ cwd, feature: "Add review gate", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  await runBuildStage({ cwd, jobId: job.id, builder, worktree: provider(cwd), now: NOW, runValidation: async (command) => ({ ...command, outcome: "PASS" as const }) });
  return job.id;
}

test("selected reviewers persist their plan and all valid reports advance to approval", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReview(cwd);
    const result = await runReviewStage({ cwd, jobId, reviewers: { security: passReviewer, code: passReviewer }, now: NOW });
    assert.equal(result.job.stage, "approval");
    assert.deepEqual(result.job.review_plan, { selected: ["security", "code"], skipped: ["ui"], reasons: { ui: "No reviewer adapter configured" } });
    assert.equal(result.reports.security?.verdict, "PASS");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd, "factory", "jobs", jobId, "review-plan.json"), "utf8")), result.job.review_plan);
    assert.deepEqual((await readJobEvents(cwd, jobId)).map((event) => event.event), ["job_created", "spec_complete", "build_complete", "review_started", "review_complete"]);
  } finally { await removeTempRepo(cwd); }
});

test("skipped reviewers require durable reasons and do not block WAIT FOR ALL", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReview(cwd);
    const result = await runReviewStage({
      cwd, jobId, reviewers: { security: passReviewer, ui: passReviewer }, now: NOW,
      select: () => ({ selected: ["security"], skipped: ["code", "ui"], reasons: { code: "Not selected", ui: "No visual changes" } }),
    });
    assert.equal(result.job.stage, "approval");
    assert.deepEqual(result.job.review_plan?.skipped, ["code", "ui"]);
  } finally { await removeTempRepo(cwd); }
});

test("a missing or malformed selected report never passes the review gate", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReview(cwd);
    await assert.rejects(() => runReviewStage({ cwd, jobId, reviewers: { code: async () => {} }, now: NOW }), ReviewIncompleteError);
    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.stage, "review");
    assert.equal(board.jobs[0]?.status, "active");
  } finally { await removeTempRepo(cwd); }
});

test("blocking changes starts the next numbered build round", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReview(cwd);
    const blocking: Reviewer = async ({ reportFile }) => fs.writeFile(reportFile, "VERDICT: CHANGES\nSEVERITY: BLOCKING\n\n## Summary\n\nFix it.\n\n## Findings\n\nBug.\n\n## Evidence\n\nDiff.\n\n## Recommendations\n\nFix.\n");
    const result = await runReviewStage({ cwd, jobId, reviewers: { code: blocking }, now: NOW });
    assert.equal(result.job.stage, "build");
    assert.equal(result.job.round, 2);
    assert.equal(result.job.review_plan, null);
    assert.ok(await fs.stat(path.join(cwd, "factory", "jobs", jobId, "round-1", "build.md")));
  } finally { await removeTempRepo(cwd); }
});

test("review lock contention leaves the active job unchanged", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReview(cwd);
    const held = await acquireLock(path.join(cwd, "factory", "jobs", jobId, ".review.lock"));
    try {
      await assert.rejects(() => runReviewStage({ cwd, jobId, reviewers: { code: passReviewer }, now: NOW, lockOptions: { timeoutMs: 5, pollMs: 1 } }), /timed out/);
      const board = await readBoard(cwd);
      assert.equal(board.jobs[0]?.stage, "review");
      assert.equal(board.jobs[0]?.status, "active");
    } finally { await held.release(); }
  } finally { await removeTempRepo(cwd); }
});

test("blocking changes at the configured round limit escalate to a human", async () => {
  const cwd = await makeTempRepo();
  try {
    await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".pi", "factory.json"), JSON.stringify({ schema_version: 1, reviewers: { available: ["code"], required: ["code"] }, limits: { max_review_rounds: 1 } }));
    const jobId = await seedReview(cwd);
    const blocking: Reviewer = async ({ reportFile }) => fs.writeFile(reportFile, "VERDICT: CHANGES\nSEVERITY: BLOCKING\n\n## Summary\n\nNo.\n\n## Findings\n\nBug.\n\n## Evidence\n\nDiff.\n\n## Recommendations\n\nFix.\n");
    const result = await runReviewStage({ cwd, jobId, reviewers: { code: blocking }, now: NOW });
    assert.equal(result.job.status, "needs-human");
    assert.equal(result.job.stage, "review");
  } finally { await removeTempRepo(cwd); }
});
