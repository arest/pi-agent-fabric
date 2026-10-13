import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { acquireLock, LockTimeoutError } from "../src/state/lock.ts";
import { factoryPaths, jobBranchLock, promotionTargetLock } from "../src/state/paths.ts";
import { runApprovalStage, type Approver } from "../src/workflow/approval-stage.ts";
import { runBuildStage, type WorktreeProvider } from "../src/workflow/build-stage.ts";
import { promoteJob } from "../src/workflow/operator-commands.ts";
import { runPublicationStage, type PublicationAdapter } from "../src/workflow/publication-stage.ts";
import { runReviewStage } from "../src/workflow/review-stage.ts";
import { runSpecStage } from "../src/workflow/spec-stage.ts";
import { startJob } from "../src/workflow/start-job.ts";
import {
  completeSpecMarkdown,
  configureFactory,
  evidenceBuilder as builder,
  passReviewer,
  approveDecision,
  makeTempRepo,
  readBoard,
  removeTempRepo,
  stubWorktreeProvider,
} from "./helpers/harness.ts";

const NOW = (): Date => new Date("2026-02-03T04:05:06.000Z");

/** Drive a job to the review stage with a completed build. */
async function seedReviewable(cwd: string): Promise<string> {
  await configureFactory(cwd);
  const { job } = await startJob({ cwd, feature: "Concurrency", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  return job.id;
}

/** Drive a job to a published `waiting_for_human` PR. */
async function seedPublished(cwd: string): Promise<string> {
  const jobId = await seedReviewable(cwd);
  await runBuildStage({
    cwd,
    jobId,
    builder,
    worktree: stubWorktreeProvider(cwd),
    now: NOW,
    runValidation: async (command) => ({ ...command, outcome: "PASS" as const }),
  });
  await runReviewStage({ cwd, jobId, reviewers: { code: passReviewer }, now: NOW });
  const approver: Approver = async ({ decisionFile }) => fs.writeFile(decisionFile, approveDecision);
  await runApprovalStage({ cwd, jobId, approver, now: NOW });
  await runPublicationStage({
    cwd,
    jobId,
    adapter: {
      preflight: async () => {},
      ensurePullRequest: async () => ({
        url: "https://github.com/arest/pi-agent-fabric/pull/123",
        state: "OPEN",
        merge_state: "WAITING_FOR_HUMAN",
      }),
    },
    now: NOW,
  });
  return jobId;
}

test("the job branch lock is held while the worktree provider prepares the branch", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    const paths = factoryPaths(cwd);
    let lockExistedDuringPrepare = false;
    const observing: WorktreeProvider = {
      prepare: async () => {
        lockExistedDuringPrepare = await fs
          .access(jobBranchLock(paths, jobId))
          .then(() => true)
          .catch(() => false);
        return { path: cwd, lockPath: path.join(cwd, "builder.lock") };
      },
    };

    await runBuildStage({
      cwd,
      jobId,
      builder,
      worktree: observing,
      now: NOW,
      runValidation: async (command) => ({ ...command, outcome: "PASS" as const }),
    });
    assert.equal(lockExistedDuringPrepare, true);
    // The branch lock is released once the stage ends.
    await assert.rejects(() => fs.access(jobBranchLock(paths, jobId)));
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a held branch lock reports contention and leaves the build untouched", async (t) => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    const paths = factoryPaths(cwd);
    const held = await acquireLock(jobBranchLock(paths, jobId));
    t.after(() => held.release());

    await assert.rejects(
      () =>
        runBuildStage({
          cwd,
          jobId,
          builder,
          worktree: stubWorktreeProvider(cwd),
          now: NOW,
          runValidation: async (command) => ({ ...command, outcome: "PASS" as const }),
          lockOptions: { timeoutMs: 120, pollMs: 10 },
        }),
      LockTimeoutError,
    );
    const job = (await readBoard(cwd)).jobs[0];
    // Contention is reported, never guessed through: the job is still
    // build/active, exactly as the live branch owner expects.
    assert.equal(job?.stage, "build");
    assert.equal(job?.status, "active");
    assert.deepEqual(job?.history.filter((entry) => (entry.event ?? "").startsWith("build_failed")), []);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("the job branch lock is held while publication pushes the shared branch", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    await runBuildStage({
      cwd,
      jobId,
      builder,
      worktree: stubWorktreeProvider(cwd),
      now: NOW,
      runValidation: async (command) => ({ ...command, outcome: "PASS" as const }),
    });
    await runReviewStage({ cwd, jobId, reviewers: { code: passReviewer }, now: NOW });
    const approver = async ({ decisionFile }: { decisionFile: string }) => fs.writeFile(decisionFile, approveDecision);
    const { runApprovalStage } = await import("../src/workflow/approval-stage.ts");
    await runApprovalStage({ cwd, jobId, approver, now: NOW });

    const paths = factoryPaths(cwd);
    let lockExistedDuringPush = false;
    const adapter: PublicationAdapter = {
      preflight: async () => {},
      ensurePullRequest: async () => {
        lockExistedDuringPush = await fs
          .access(jobBranchLock(paths, jobId))
          .then(() => true)
          .catch(() => false);
        return {
          url: "https://github.com/arest/pi-agent-fabric/pull/123",
          state: "OPEN",
          merge_state: "WAITING_FOR_HUMAN",
        };
      },
    };

    await runPublicationStage({ cwd, jobId, adapter, now: NOW });
    assert.equal(lockExistedDuringPush, true);
    await assert.rejects(() => fs.access(jobBranchLock(paths, jobId)));
  } finally {
    await removeTempRepo(cwd);
  }
});

test("two jobs cannot prepare promotions to the same target branch concurrently", async (t) => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const paths = factoryPaths(cwd);
    const held = await acquireLock(promotionTargetLock(paths, "main"));
    t.after(() => held.release());

    await assert.rejects(
      () =>
        promoteJob({
          cwd,
          jobId,
          target: "main",
          adapter: {
            preparePromotion: async () => {
              throw new Error("must not run while the target branch is locked");
            },
          },
          now: NOW,
          lockOptions: { timeoutMs: 120, pollMs: 10 },
        }),
      LockTimeoutError,
    );
    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.promotion, null);

    // Contention on the target lock must not leak the per-job promotion lock:
    // the job stays promotable for this and later processes.
    const reacquireJobLock = await acquireLock(path.join(cwd, "factory", "jobs", jobId, ".promotion.lock"));
    await reacquireJobLock.release();
  } finally {
    await removeTempRepo(cwd);
  }
});
