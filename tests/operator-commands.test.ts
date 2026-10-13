import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runApprovalStage, type Approver } from "../src/workflow/approval-stage.ts";
import { runBuildStage, type Builder, type WorktreeProvider } from "../src/workflow/build-stage.ts";
import { CommandNotEligibleError, OperatorRequestError } from "../src/workflow/errors.ts";
import {
  approveJob,
  cancelJob,
  promoteJob,
  retryJob,
  reworkJob,
} from "../src/workflow/operator-commands.ts";
import { runPublicationStage, type PublicationAdapter } from "../src/workflow/publication-stage.ts";
import { runReviewStage, type Reviewer } from "../src/workflow/review-stage.ts";
import type { PromotionAdapter } from "../src/workflow/promotion/gh-adapter.ts";
import { runSpecStage } from "../src/workflow/spec-stage.ts";
import { startJob } from "../src/workflow/start-job.ts";
import { completeSpecMarkdown, makeTempRepo, readBoard, readJobEvents, removeTempRepo, boardPath, stubWorktreeProvider as provider, evidenceBuilder as builder, passReviewer, blockingReviewer, approveDecision, escalateDecision, configureFactory } from "./helpers/harness.ts";
import { createHarness } from "./helpers/harness.ts";

const NOW = (): Date => new Date("2026-02-03T04:05:06.000Z");

/** Drive a job to the review stage with a completed build. */
async function seedReviewable(cwd: string): Promise<string> {
  await configureFactory(cwd);
  const { job } = await startJob({ cwd, feature: "Operator commands", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  await runBuildStage({
    cwd,
    jobId: job.id,
    builder,
    worktree: provider(cwd),
    now: NOW,
    runValidation: async (command) => ({ ...command, outcome: "PASS" as const }),
  });
  return job.id;
}

/** Drive a job to an approver ESCALATE human escalation. */
async function seedApprovalEscalation(cwd: string): Promise<string> {
  const jobId = await seedReviewable(cwd);
  await runReviewStage({ cwd, jobId, reviewers: { code: passReviewer }, now: NOW });
  const approver: Approver = async ({ decisionFile }) => fs.writeFile(decisionFile, escalateDecision);
  await runApprovalStage({ cwd, jobId, approver, now: NOW });
  return jobId;
}

/** Drive a job to a review-exhaustion human escalation. */
async function seedReviewExhaustion(cwd: string): Promise<string> {
  await configureFactory(cwd, { limits: { max_review_rounds: 1 } });
  const { job } = await startJob({ cwd, feature: "Review exhaustion", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  await runBuildStage({
    cwd,
    jobId: job.id,
    builder,
    worktree: provider(cwd),
    now: NOW,
    runValidation: async (command) => ({ ...command, outcome: "PASS" as const }),
  });
  await runReviewStage({ cwd, jobId: job.id, reviewers: { code: blockingReviewer }, now: NOW });
  return job.id;
}

/** Drive a job to a published `waiting_for_human` PR. */
async function seedPublished(cwd: string): Promise<string> {
  const jobId = await seedReviewable(cwd);
  await runReviewStage({ cwd, jobId, reviewers: { code: passReviewer }, now: NOW });
  const approver: Approver = async ({ decisionFile }) => fs.writeFile(decisionFile, approveDecision);
  await runApprovalStage({ cwd, jobId, approver, now: NOW });
  const adapter: PublicationAdapter = {
    preflight: async () => {},
    ensurePullRequest: async () => ({
      url: "https://github.com/arest/pi-agent-fabric/pull/123",
      state: "OPEN",
      merge_state: "WAITING_FOR_HUMAN",
    }),
  };
  await runPublicationStage({ cwd, jobId, adapter, now: NOW });
  return jobId;
}

/** Drive a job into the recoverable `blocked` build state. */
async function seedBlocked(cwd: string): Promise<string> {
  await configureFactory(cwd);
  const { job } = await startJob({ cwd, feature: "Blocked build", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  await assert.rejects(
    () =>
      runBuildStage({
        cwd,
        jobId: job.id,
        // A builder that writes no evidence is a recoverable failure, not a guess.
        builder: async () => {},
        worktree: provider(cwd),
        now: NOW,
        runValidation: async (command) => ({ ...command, outcome: "PASS" as const }),
      }),
  );
  return job.id;
}

test("approve resolves an approver escalation and records the human action", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApprovalEscalation(cwd);
    const before = await readBoard(cwd);
    assert.equal(before.jobs[0]?.status, "needs-human");

    const result = await approveJob({ cwd, jobId, note: "Accepted rollout risk; merging is still human-controlled", now: NOW });

    assert.equal(result.job.stage, "publication");
    assert.equal(result.job.status, "active");
    assert.equal(result.job.approval, "APPROVE");
    assert.ok(result.job.history.length > before.jobs[0]!.history.length, "history grows, never shrinks");
    assert.ok(result.job.history.some((entry) => entry.event === "approval_escalated"), "the approver decision is retained");
    assert.equal(result.job.history.at(-1)?.actor, "operator");

    const events = await readJobEvents(cwd, jobId);
    const human = events.at(-1);
    assert.equal(human?.event, "human_approved");
    assert.equal(human?.note, "Accepted rollout risk; merging is still human-controlled");
    assert.ok(events.some((event) => event.event === "approval_escalated"), "the escalation event is retained");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("approve is rejected for a job that is not an approver escalation", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    const before = await readBoard(cwd);

    await assert.rejects(() => approveJob({ cwd, jobId, now: NOW }), CommandNotEligibleError);

    const after = await readBoard(cwd);
    assert.deepEqual(after, before, "an ineligible command must not mutate the board");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("rework opens the next numbered round and retains the closed round's evidence", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApprovalEscalation(cwd);
    const before = await readBoard(cwd);

    const result = await reworkJob({ cwd, jobId, note: "Tighten the rollout guard before release", now: NOW });

    assert.equal(result.job.stage, "build");
    assert.equal(result.job.status, "active");
    assert.equal(result.job.round, 2);
    assert.equal(result.job.review_plan, null);
    assert.ok(result.job.history.length > before.jobs[0]!.history.length);
    assert.ok(result.job.history.some((entry) => entry.event === "approval_escalated"), "prior escalation stays in history");

    // The closed round's review plan is retained for the next builder round.
    await fs.access(path.join(cwd, "factory", "jobs", jobId, "round-1", "review-plan.json"));

    const events = await readJobEvents(cwd, jobId);
    const human = events.at(-1);
    assert.equal(human?.event, "human_rework");
    assert.equal(human?.note, "Tighten the rollout guard before release");
    assert.equal(human?.round, 1);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("the resumed builder receives the human rework note", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApprovalEscalation(cwd);
    await reworkJob({ cwd, jobId, note: "Add a kill switch", now: NOW });

    let seenNotes: string[] = [];
    const capturingBuilder: Builder = async ({ buildFile, rework }) => {
      seenNotes = rework?.humanNotes ?? [];
      await fs.writeFile(buildFile, "## Changed files\n\n- src/example.ts\n\n## Validation\n\n- PASS\n\n## Remaining risks\n\nNone\n");
    };
    await runBuildStage({
      cwd,
      jobId,
      builder: capturingBuilder,
      worktree: provider(cwd),
      now: NOW,
      runValidation: async (command) => ({ ...command, outcome: "PASS" as const }),
    });

    assert.deepEqual(seenNotes, ["Add a kill switch"]);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("rework recovers a review-exhausted job without deleting prior reports", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewExhaustion(cwd);
    const report = path.join(cwd, "factory", "jobs", jobId, "round-1", "review-code.md");
    await fs.access(report);

    const result = await reworkJob({ cwd, jobId, note: "Address the blocking finding manually", now: NOW });

    assert.equal(result.job.stage, "build");
    assert.equal(result.job.round, 2);
    assert.equal(result.job.status, "active");
    await fs.access(report);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("rework requires an operator note", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApprovalEscalation(cwd);
    await assert.rejects(() => reworkJob({ cwd, jobId, now: NOW }), OperatorRequestError);
    await assert.rejects(() => reworkJob({ cwd, jobId, note: "   ", now: NOW }), OperatorRequestError);
    await assert.rejects(
      () => reworkJob({ cwd, jobId, note: "x".repeat(4001), now: NOW }),
      /at most 4000 characters/,
    );
    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.round, 1);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("retry clears a recoverable blocked condition and rejects an active job", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedBlocked(cwd);
    assert.equal((await readBoard(cwd)).jobs[0]?.status, "blocked");

    const result = await retryJob({ cwd, jobId, note: "Provider hiccup; run the builder again", now: NOW });
    assert.equal(result.job.status, "active");
    assert.equal(result.job.stage, "build");
    const events = await readJobEvents(cwd, jobId);
    assert.equal(events.at(-1)?.event, "human_retry");
    assert.equal(events.at(-1)?.note, "Provider hiccup; run the builder again");

    await assert.rejects(() => retryJob({ cwd, jobId, now: NOW }), CommandNotEligibleError);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("cancel marks a published job cancelled and preserves its artifacts and PR", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const jobDir = path.join(cwd, "factory", "jobs", jobId);
    let stopped: string | null = null;

    const result = await cancelJob({
      cwd,
      jobId,
      note: "Superseded by another change",
      now: NOW,
      stopActiveWork: async (job) => {
        stopped = job.id;
      },
    });

    assert.equal(stopped, jobId, "active child work is stopped where possible");
    assert.equal(result.job.status, "cancelled");
    assert.equal(result.job.stage, "waiting_for_human", "cancel does not rewrite the stage");
    assert.equal(result.job.pull_request?.url, "https://github.com/arest/pi-agent-fabric/pull/123");

    // Durable artifacts are never deleted by cancellation.
    await fs.access(path.join(jobDir, "decision.md"));
    await fs.access(path.join(jobDir, "build.md"));
    await fs.access(path.join(jobDir, "round-1", "review-code.md"));

    const events = await readJobEvents(cwd, jobId);
    assert.equal(events.at(-1)?.event, "job_cancelled");
    assert.equal(events.at(-1)?.note, "Superseded by another change");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("cancel fails closed when active work cannot be stopped", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const before = await readBoard(cwd);

    await assert.rejects(
      () =>
        cancelJob({
          cwd,
          jobId,
          now: NOW,
          stopActiveWork: async () => {
            throw new Error("subagent refused to stop");
          },
        }),
      /refused to stop/,
    );

    assert.deepEqual(await readBoard(cwd), before, "a failed cancel leaves the job untouched");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("cancel rejects terminal jobs", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    await cancelJob({ cwd, jobId, now: NOW });
    await assert.rejects(() => cancelJob({ cwd, jobId, now: NOW }), CommandNotEligibleError);

    const raw = JSON.parse(await fs.readFile(boardPath(cwd), "utf8")) as { jobs: Array<{ status: string }> };
    raw.jobs[0]!.status = "merged";
    await fs.writeFile(boardPath(cwd), JSON.stringify(raw, null, 2));
    await assert.rejects(() => cancelJob({ cwd, jobId, now: NOW }), CommandNotEligibleError);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("promote prepares a human-merged promotion PR and never merges", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const calls: string[] = [];
    const adapter: PromotionAdapter = {
      async preparePromotion({ target, job }) {
        calls.push(`${job.target}->${target}`);
        return { url: "https://github.com/arest/pi-agent-fabric/pull/200", state: "OPEN", merge_state: "WAITING_FOR_HUMAN" };
      },
    };

    const result = await promoteJob({ cwd, jobId, adapter, now: NOW });

    assert.deepEqual(calls, ["develop->main"]);
    assert.equal(result.promotion.merge_state, "WAITING_FOR_HUMAN");
    assert.deepEqual(result.job.promotion, result.promotion);
    assert.equal(result.job.pull_request?.url, "https://github.com/arest/pi-agent-fabric/pull/123", "the publication PR is untouched");
    assert.equal(result.job.stage, "waiting_for_human");

    const events = await readJobEvents(cwd, jobId);
    assert.equal(events.at(-1)?.event, "promotion_prepared");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("promote targets master on request and rejects a job that is not published", async () => {
  const cwd = await makeTempRepo();
  try {
    const published = await seedPublished(cwd);
    let target: string | null = null;
    const adapter: PromotionAdapter = {
      async preparePromotion(input) {
        target = input.target;
        return { url: "https://example.test/pr/1", state: "OPEN", merge_state: "WAITING_FOR_HUMAN" };
      },
    };
    await promoteJob({ cwd, jobId: published, target: "master", adapter, now: NOW });
    assert.equal(target, "master");

    const unpublished = await seedReviewable(cwd);
    await assert.rejects(() => promoteJob({ cwd, jobId: unpublished, adapter, now: NOW }), CommandNotEligibleError);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a failed promotion leaves the board unmutated", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const before = await readBoard(cwd);
    const adapter: PromotionAdapter = {
      async preparePromotion() {
        throw new Error("gh pr create failed");
      },
    };

    await assert.rejects(() => promoteJob({ cwd, jobId, adapter, now: NOW }), /gh pr create failed/);
    assert.deepEqual(await readBoard(cwd), before);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a concurrent board change during promotion fails closed rather than recording stale state", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const adapter: PromotionAdapter = {
      async preparePromotion() {
        // Simulate another writer landing between the eligibility guard and the
        // board write, exactly the window the version check exists to close.
        const raw = JSON.parse(await fs.readFile(boardPath(cwd), "utf8")) as { version: number };
        raw.version += 1;
        await fs.writeFile(boardPath(cwd), JSON.stringify(raw, null, 2));
        return { url: "https://example.test/pr/9", state: "OPEN", merge_state: "WAITING_FOR_HUMAN" };
      },
    };

    await assert.rejects(() => promoteJob({ cwd, jobId, adapter, now: NOW }), /version/);
    assert.equal((await readBoard(cwd)).jobs[0]?.promotion, null, "no stale promotion is recorded");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a promotion interrupted after the GitHub call is recoverable by re-running promote", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const url = "https://github.com/arest/pi-agent-fabric/pull/201";
    let attempts = 0;
    const adapter: PromotionAdapter = {
      async preparePromotion() {
        attempts += 1;
        // First attempt opens the PR but the process dies before recording it;
        // the second attempt must adopt the same PR, not open a duplicate.
        if (attempts === 1) throw new Error("process interrupted after pr create");
        return { url, state: "OPEN", merge_state: "WAITING_FOR_HUMAN" };
      },
    };

    await assert.rejects(() => promoteJob({ cwd, jobId, adapter, now: NOW }), /interrupted/);
    assert.equal((await readBoard(cwd)).jobs[0]?.promotion, null);

    const result = await promoteJob({ cwd, jobId, adapter, now: NOW });
    assert.equal(result.promotion.url, url);
    assert.equal((await readBoard(cwd)).jobs[0]?.promotion?.url, url, "the retry records the adopted PR once");
    assert.equal(attempts, 2);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("the command surface reports operator outcomes and explicit ineligibility", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApprovalEscalation(cwd);
    const harness = createHarness(cwd);

    await harness.run("factory", `approve ${jobId} human sign-off`);
    assert.equal(harness.notifications.at(-1)?.type, "info");
    assert.match(harness.notifications.at(-1)?.message ?? "", /Human approval recorded/);
    assert.equal((await readBoard(cwd)).jobs[0]?.stage, "publication");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("the command surface reports usage and refusal for malformed input", async () => {
  const cwd = await makeTempRepo();
  try {
    const harness = createHarness(cwd);

    await harness.run("factory", "rework");
    assert.equal(harness.notifications.at(-1)?.type, "warning");
    assert.match(harness.notifications.at(-1)?.message ?? "", /Usage: \/factory rework/);

    await harness.run("factory", "approve 999-missing");
    assert.equal(harness.notifications.at(-1)?.type, "error");
    assert.match(harness.notifications.at(-1)?.message ?? "", /no factory job 999-missing/);

    const jobId = await seedApprovalEscalation(cwd);
    await harness.run("factory", `rework ${jobId}`);
    assert.equal(harness.notifications.at(-1)?.type, "warning");
    assert.match(harness.notifications.at(-1)?.message ?? "", /requires an operator note/);
  } finally {
    await removeTempRepo(cwd);
  }
});
