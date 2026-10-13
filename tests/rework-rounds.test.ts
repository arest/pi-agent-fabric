import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runBuildStage, type Builder, type BuilderInput, type WorktreeProvider } from "../src/workflow/build-stage.ts";
import { runReviewStage, type Reviewer } from "../src/workflow/review-stage.ts";
import { runSpecStage } from "../src/workflow/spec-stage.ts";
import { startJob } from "../src/workflow/start-job.ts";
import { ReworkContextError } from "../src/workflow/errors.ts";
import { appendJobEvent } from "../src/state/job-events.ts";
import { factoryPaths } from "../src/state/paths.ts";
import { completeSpecMarkdown, makeTempRepo, readBoard, readJobEvents, removeTempRepo } from "./helpers/harness.ts";

const NOW = (): Date => new Date("2026-02-03T04:05:06.000Z");
const provider = (cwd: string): WorktreeProvider => ({ prepare: async () => ({ path: cwd, lockPath: path.join(cwd, "builder.lock") }) });
const builder: Builder = async ({ buildFile }) => fs.writeFile(buildFile, "## Changed files\n\n- src/example.ts\n\n## Validation\n\n- PASS\n\n## Remaining risks\n\nNone\n");
const passReviewer: Reviewer = async ({ reportFile, role }) => fs.writeFile(reportFile, report(role, "PASS", "NON-BLOCKING", "Looks good."));
const blockingReviewer: Reviewer = async ({ reportFile, role }) => fs.writeFile(reportFile, report(role, "CHANGES", "BLOCKING", "Bug."));

function report(role: string, verdict: string, severity: string, summary: string): string {
  return `# ${role} review\n\nVERDICT: ${verdict}\nSEVERITY: ${severity}\n\n## Summary\n\n${summary}\n\n## Findings\n\n${summary}\n\n## Evidence\n\nDiff.\n\n## Recommendations\n\nFix.\n`;
}

async function seed(cwd: string, policy?: Record<string, unknown>): Promise<string> {
  if (policy) {
    await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".pi", "factory.json"), JSON.stringify({ schema_version: 1, ...policy }));
  }
  const { job } = await startJob({ cwd, feature: "Add rework rounds", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  await runBuildStage({ cwd, jobId: job.id, builder, worktree: provider(cwd), now: NOW, runValidation: async (command) => ({ ...command, outcome: "PASS" as const }) });
  return job.id;
}

test("blocking findings retain the closed round and open the next numbered build round", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seed(cwd, { reviewers: { available: ["code"], required: ["code"] } });
    const result = await runReviewStage({ cwd, jobId, reviewers: { code: blockingReviewer }, now: NOW });

    assert.equal(result.job.stage, "build");
    assert.equal(result.job.status, "active");
    assert.equal(result.job.round, 2);
    assert.equal(result.job.review_plan, null);

    const roundDir = path.join(cwd, "factory", "jobs", jobId, "round-1");
    assert.ok(await fs.stat(path.join(roundDir, "review-code.md")));
    assert.ok(await fs.stat(path.join(roundDir, "build.md")));
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(roundDir, "review-plan.json"), "utf8")),
      { selected: ["code"], skipped: [], reasons: {} },
    );
    assert.equal(result.job.verdicts["code:round-1"], "CHANGES");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("the resumed builder receives the blocking findings from the previous round", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seed(cwd, { reviewers: { available: ["code"], required: ["code"] } });
    await runReviewStage({ cwd, jobId, reviewers: { code: blockingReviewer }, now: NOW });

    let seen: BuilderInput | undefined;
    const capturing: Builder = async (input) => {
      seen = input;
      await builder(input);
    };
    await runBuildStage({ cwd, jobId, builder: capturing, worktree: provider(cwd), now: NOW, runValidation: async (command) => ({ ...command, outcome: "PASS" as const }) });

    assert.equal(seen?.round, 2);
    assert.equal(seen?.rework?.fromRound, 1);
    assert.deepEqual(seen?.rework?.blocking.map((finding) => [finding.role, finding.verdict, finding.severity]), [["code", "CHANGES", "BLOCKING"]]);
    assert.equal(seen?.rework?.priorReports.length, 1);
    assert.equal(seen?.rework?.priorReports[0]?.file, path.join(cwd, "factory", "jobs", jobId, "round-1", "review-code.md"));
  } finally {
    await removeTempRepo(cwd);
  }
});

test("each round's transition events are durable in the append-only log", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seed(cwd, { reviewers: { available: ["code"], required: ["code"] } });
    await runReviewStage({ cwd, jobId, reviewers: { code: blockingReviewer }, now: NOW });
    await runBuildStage({ cwd, jobId, builder, worktree: provider(cwd), now: NOW, runValidation: async (command) => ({ ...command, outcome: "PASS" as const }) });
    const result = await runReviewStage({ cwd, jobId, reviewers: { code: passReviewer }, now: NOW });

    assert.equal(result.job.stage, "approval");
    assert.deepEqual(result.job.verdicts, { "code:round-1": "CHANGES", "code:round-2": "PASS" });
    assert.deepEqual(
      (await readJobEvents(cwd, jobId)).map((event) => [event.event, event.round]),
      [
        ["job_created", 1],
        ["spec_complete", 1],
        ["build_complete", 1],
        ["review_started", 1],
        ["review_rework", 1],
        ["build_complete", 2],
        ["review_started", 2],
        ["review_complete", 2],
      ],
    );
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a legacy round-less event suppresses only the first round's duplicate", async () => {
  // Round 1: the legacy record stands in for the crash-window duplicate.
  const legacyCwd = await makeTempRepo();
  try {
    const { job } = await startJob({ cwd: legacyCwd, feature: "Legacy events", now: NOW });
    await runSpecStage({ cwd: legacyCwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
    await appendJobEvent(factoryPaths(legacyCwd), job.id, { at: NOW().toISOString(), from: "build", to: "review", actor: "factory", event: "build_complete" });
    await runBuildStage({ cwd: legacyCwd, jobId: job.id, builder, worktree: provider(legacyCwd), now: NOW, runValidation: async (command) => ({ ...command, outcome: "PASS" as const }) });
    assert.deepEqual((await readJobEvents(legacyCwd, job.id)).filter((event) => event.event === "build_complete").map((event) => event.round), [undefined]);
  } finally {
    await removeTempRepo(legacyCwd);
  }

  // Round 2: a legacy record must not swallow the next round's event.
  const cwd = await makeTempRepo();
  try {
    const jobId = await seed(cwd, { reviewers: { available: ["code"], required: ["code"] } });
    await runReviewStage({ cwd, jobId, reviewers: { code: blockingReviewer }, now: NOW });
    await appendJobEvent(factoryPaths(cwd), jobId, { at: NOW().toISOString(), from: "build", to: "review", actor: "factory", event: "build_complete" });
    await runBuildStage({ cwd, jobId, builder, worktree: provider(cwd), now: NOW, runValidation: async (command) => ({ ...command, outcome: "PASS" as const }) });
    assert.deepEqual((await readJobEvents(cwd, jobId)).filter((event) => event.event === "build_complete").map((event) => event.round), [1, undefined, 2]);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a retried build after the event append crash window does not duplicate the round event", async () => {
  const cwd = await makeTempRepo();
  try {
    const { job } = await startJob({ cwd, feature: "Add rework rounds", now: NOW });
    await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
    // Simulate a crash after the event append but before the board write.
    await appendJobEvent(factoryPaths(cwd), job.id, { at: NOW().toISOString(), from: "build", to: "review", actor: "factory", event: "build_complete", round: 1 });
    await runBuildStage({ cwd, jobId: job.id, builder, worktree: provider(cwd), now: NOW, runValidation: async (command) => ({ ...command, outcome: "PASS" as const }) });

    const buildCompletions = (await readJobEvents(cwd, job.id)).filter((event) => event.event === "build_complete" && event.round === 1);
    assert.equal(buildCompletions.length, 1);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("round exhaustion is an explicit, immutable human-needed state", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seed(cwd, { reviewers: { available: ["code"], required: ["code"] }, limits: { max_review_rounds: 1 } });
    const result = await runReviewStage({ cwd, jobId, reviewers: { code: blockingReviewer }, now: NOW });

    assert.equal(result.job.status, "needs-human");
    assert.equal(result.job.stage, "review");
    assert.equal(result.job.round, 1);
    assert.equal(result.job.history.at(-1)?.event, "review_exhausted");
    assert.equal(result.job.history.at(-1)?.round, 1);
    assert.ok(await fs.stat(path.join(cwd, "factory", "jobs", jobId, "round-1", "review-plan.json")));
    await assert.rejects(() => runReviewStage({ cwd, jobId, reviewers: { code: passReviewer }, now: NOW }), /expected stage review with status active/);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a rework round fails closed when retained prior evidence cannot be read", async () => {
  for (const damage of ["missing", "malformed"] as const) {
    const cwd = await makeTempRepo();
    try {
      const jobId = await seed(cwd, { reviewers: { available: ["code"], required: ["code"] } });
      await runReviewStage({ cwd, jobId, reviewers: { code: blockingReviewer }, now: NOW });
      const reportFile = path.join(cwd, "factory", "jobs", jobId, "round-1", "review-code.md");
      if (damage === "missing") await fs.rm(reportFile);
      else await fs.writeFile(reportFile, "not a review report");

      let called = false;
      await assert.rejects(
        () => runBuildStage({ cwd, jobId, builder: async (input) => { called = true; await builder(input); }, worktree: provider(cwd), now: NOW }),
        ReworkContextError,
      );
      assert.equal(called, false);
      const board = await readBoard(cwd);
      assert.equal(board.jobs[0]?.stage, "build");
      assert.equal(board.jobs[0]?.status, "needs-human");
      assert.equal(board.jobs[0]?.history.at(-1)?.event, "build_failed:rework_context");
    } finally {
      await removeTempRepo(cwd);
    }
  }
});
