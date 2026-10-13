import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { acquireLock, LockTimeoutError } from "../src/state/lock.ts";
import { BoardStore, StaleBoardError } from "../src/state/board-store.ts";
import type { Job } from "../src/state/board.ts";
import { factoryPaths, factoryRecoveryLock, jobBuildFile, jobReviewPlan } from "../src/state/paths.ts";
import { runApprovalStage } from "../src/workflow/approval-stage.ts";
import { runBuildStage, type WorktreeProvider } from "../src/workflow/build-stage.ts";
import { runPublicationStage, type PublicationAdapter } from "../src/workflow/publication-stage.ts";
import {
  runRecoveryStage,
  type GitHubEvidenceAdapter,
  type GitEvidenceAdapter,
} from "../src/workflow/recovery.ts";
import { runReviewStage } from "../src/workflow/review-stage.ts";
import { runSpecStage } from "../src/workflow/spec-stage.ts";
import { startJob } from "../src/workflow/start-job.ts";
import {
  completeSpecMarkdown,
  configureFactory,
  evidenceBuilder as builder,
  passReviewer,
  approveDecision,
  escalateDecision,
  makeTempRepo,
  readBoard,
  readJobEvents,
  removeTempRepo,
  stubWorktreeProvider as provider,
} from "./helpers/harness.ts";
import { createHarness } from "./helpers/harness.ts";

const NOW = (): Date => new Date("2026-02-03T04:05:06.000Z");

const branchExists: GitEvidenceAdapter = { branchExists: async () => true };
const openPr: GitHubEvidenceAdapter = { pullRequestState: async () => "open" };

/** Drive a job to the review stage with a completed build. */
async function seedReviewable(cwd: string): Promise<string> {
  await configureFactory(cwd);
  const { job } = await startJob({ cwd, feature: "Recovery", now: NOW });
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

/** Drive a job to the approval stage with reviewer and approver APPROVE evidence. */
async function seedApproved(cwd: string, decision = approveDecision): Promise<string> {
  const jobId = await seedReviewable(cwd);
  await runReviewStage({ cwd, jobId, reviewers: { code: passReviewer }, now: NOW });
  const approver = async ({ decisionFile }: { decisionFile: string }) => fs.writeFile(decisionFile, decision);
  await runApprovalStage({ cwd, jobId, approver, now: NOW });
  return jobId;
}

/** Drive a job to a published `waiting_for_human` PR. */
async function seedPublished(cwd: string): Promise<string> {
  const jobId = await seedApproved(cwd);
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

/** Apply a direct patch to one job on the board. */
async function patchJob(cwd: string, jobId: string, patch: (job: Job) => void): Promise<void> {
  await new BoardStore(cwd).mutate(async (draft) => {
    const job = draft.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`test setup: no job ${jobId}`);
    patch(job);
  });
}

function outcomeOf(result: Awaited<ReturnType<typeof runRecoveryStage>>, jobId: string) {
  const outcome = result.outcomes.find((candidate) => candidate.jobId === jobId);
  if (!outcome) throw new Error(`no recovery outcome for ${jobId}`);
  return outcome;
}

test("recovery leaves consistent jobs untouched and writes no board", async () => {
  const cwd = await makeTempRepo();
  try {
    const { job } = await startJob({ cwd, feature: "Untouched", now: NOW });
    const before = await readBoard(cwd);
    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    const outcome = outcomeOf(result, job.id);
    assert.equal(outcome.action, "unchanged");
    // No reconciliation, no write: the version is unchanged and no history or
    // event was appended.
    const after = await readBoard(cwd);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.jobs[0]?.history, before.jobs[0]?.history);
    assert.deepEqual(await readJobEvents(cwd, job.id).then((events) => events.filter((event) => event.event === "recovered")), []);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("recovery with no board reports nothing and creates no board", async () => {
  const cwd = await makeTempRepo();
  try {
    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    assert.deepEqual(result.outcomes, []);
    await assert.rejects(() => fs.readFile(path.join(cwd, "factory", "board.json"), "utf8"));
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a build job whose spec artifact disappeared resumes at the spec stage", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    await patchJob(cwd, jobId, (job) => {
      job.stage = "build";
    });
    await fs.rm(path.join(cwd, "factory", "jobs", jobId, "spec.md"));

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.action, "reconciled");
    assert.equal(outcome.stage, "spec");
    assert.equal(outcome.status, "active");

    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.stage, "spec");
    assert.equal(job?.status, "active");
    assert.ok((job?.history ?? []).some((entry) => entry.event === "recovered" && entry.from === "build" && entry.to === "spec"));
    assert.deepEqual((await readJobEvents(cwd, jobId)).filter((event) => event.event === "recovered").length, 1);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a review job whose build evidence disappeared resumes at the build stage", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    await fs.rm(jobBuildFile(factoryPaths(cwd), jobId));

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.stage, "build");
    assert.equal(outcome.status, "active");

    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.stage, "build");
    assert.equal(job?.status, "active");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a partial review round without verdicts is incomplete, not a pass, and stays resumable", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    const paths = factoryPaths(cwd);
    await patchJob(cwd, jobId, (job) => {
      job.review_plan = { selected: ["code"], skipped: [], reasons: {} };
    });
    await fs.mkdir(path.dirname(jobReviewPlan(paths, jobId)), { recursive: true });
    await fs.writeFile(jobReviewPlan(paths, jobId), JSON.stringify({ selected: ["code"], skipped: [], reasons: {} }));

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.action, "unchanged");
    assert.equal(outcome.stage, "review");
    assert.equal(outcome.status, "active");

    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.stage, "review");
    assert.equal(job?.status, "active");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a verdict recorded without a readable report escalates instead of guessing", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    await patchJob(cwd, jobId, (job) => {
      job.review_plan = { selected: ["code"], skipped: [], reasons: {} };
      job.verdicts["code:round-1"] = "PASS";
    });

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.status, "needs-human");
    assert.match(outcome.reason, /code/);

    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.status, "needs-human");
    assert.equal(job?.stage, "review");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a recorded approval without its decision artifact escalates to a human", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApproved(cwd);
    // The approver stage left the job at publication/active with APPROVE.
    assert.equal((await readBoard(cwd)).jobs[0]?.stage, "publication");
    await fs.rm(path.join(cwd, "factory", "jobs", jobId, "decision.md"));

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.stage, "approval");
    assert.equal(outcome.status, "needs-human");

    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.stage, "approval");
    assert.equal(job?.status, "needs-human");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a durable APPROVE artifact restores a lost board approval", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApproved(cwd);
    await patchJob(cwd, jobId, (job) => {
      job.approval = null;
      job.status = "active";
    });

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.stage, "publication");
    assert.equal(outcome.status, "active");

    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.stage, "publication");
    assert.equal(job?.status, "active");
    assert.equal(job?.approval, "APPROVE");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a durable ESCALATE artifact always wins over a recorded approval", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApproved(cwd, escalateDecision);
    // Force the board past the escalation the artifact still records.
    await patchJob(cwd, jobId, (job) => {
      job.stage = "publication";
      job.approval = "APPROVE";
      job.status = "active";
    });
    await fs.writeFile(path.join(cwd, "factory", "jobs", jobId, "decision.md"), escalateDecision);

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.stage, "approval");
    assert.equal(outcome.status, "needs-human");

    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.stage, "approval");
    assert.equal(job?.status, "needs-human");
    assert.equal(job?.approval, "ESCALATE");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a pull request merged on GitHub records the human merge", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const merged: GitHubEvidenceAdapter = { pullRequestState: async () => "merged" };

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: merged });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.action, "merged");
    assert.equal(outcome.status, "merged");

    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.status, "merged");
    assert.equal(job?.stage, "waiting_for_human");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a recorded pull request missing on GitHub escalates instead of guessing", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const missing: GitHubEvidenceAdapter = { pullRequestState: async () => null };

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: missing });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.action, "reconciled");
    assert.equal(outcome.status, "needs-human");
    assert.equal(outcome.stage, "waiting_for_human");

    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.status, "needs-human");
    assert.ok((job?.history ?? []).some((entry) => entry.event === "recovered"));
  } finally {
    await removeTempRepo(cwd);
  }
});

test("unavailable GitHub evidence fails closed to needs-human", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublished(cwd);
    const failing: GitHubEvidenceAdapter = {
      pullRequestState: async () => {
        throw new Error("gh auth expired");
      },
    };

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: failing });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.status, "needs-human");
    assert.match(outcome.reason, /gh auth expired/);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a job whose branch is missing from Git escalates instead of restarting work", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    const noBranch: GitEvidenceAdapter = { branchExists: async () => false };

    const result = await runRecoveryStage({ cwd, now: NOW, git: noBranch, github: openPr });
    const outcome = outcomeOf(result, jobId);
    assert.equal(outcome.status, "needs-human");
    assert.equal(outcome.stage, "review");
    assert.match(outcome.reason, /factory\//);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("terminal and blocked jobs are left exactly as recorded", async () => {
  const cwd = await makeTempRepo();
  try {
    const publishedId = await seedPublished(cwd);
    await patchJob(cwd, publishedId, (job) => {
      job.status = "cancelled";
    });
    const activeId = await seedReviewable(cwd);
    await patchJob(cwd, activeId, (job) => {
      job.status = "blocked";
      job.stage = "build";
    });
    await fs.rm(path.join(cwd, "factory", "jobs", activeId, "spec.md"));

    const result = await runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr });
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.action),
      ["unchanged", "unchanged"],
    );
    const board = await readBoard(cwd);
    assert.equal(board.jobs.find((job) => job.id === publishedId)?.status, "cancelled");
    assert.equal(board.jobs.find((job) => job.id === activeId)?.status, "blocked");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a concurrent board change during recovery fails closed", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedReviewable(cwd);
    // A recorded verdict without a readable report is a reconciliation target,
    // reached only after the Git evidence call — which mutates the board while
    // recovery is analyzing, so the reconciled write no longer matches the
    // analyzed version.
    await patchJob(cwd, jobId, (job) => {
      job.review_plan = { selected: ["code"], skipped: [], reasons: {} };
      job.verdicts["code:round-1"] = "PASS";
    });
    const racing: GitEvidenceAdapter = {
      branchExists: async () => {
        await patchJob(cwd, jobId, (job) => {
          job.feature = `${job.feature} (edited)`;
        });
        return true;
      },
    };

    await assert.rejects(() => runRecoveryStage({ cwd, now: NOW, git: racing, github: openPr }), StaleBoardError);
    const job = (await readBoard(cwd)).jobs[0];
    assert.equal(job?.stage, "review");
    assert.equal(job?.status, "active");
    assert.equal(job?.feature, "Recovery (edited)");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a held recovery lock reports contention without touching the board", async (t) => {
  const cwd = await makeTempRepo();
  try {
    const { job } = await startJob({ cwd, feature: "Contended recovery", now: NOW });
    const held = await acquireLock(factoryRecoveryLock(factoryPaths(cwd)));
    t.after(() => held.release());

    await assert.rejects(
      () => runRecoveryStage({ cwd, now: NOW, git: branchExists, github: openPr, lockOptions: { timeoutMs: 120, pollMs: 10 } }),
      LockTimeoutError,
    );
    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.id, job.id);
    assert.equal(board.jobs[0]?.status, "active");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("the command surface summarizes recovery and rejects arguments", async () => {
  const cwd = await makeTempRepo();
  try {
    const harness = createHarness(cwd);
    await harness.run("factory", "recover extra");
    assert.match(harness.notifications[0]?.message ?? "", /Usage: \/factory recover/);
    assert.equal(harness.notifications[0]?.type, "warning");

    await startJob({ cwd, feature: "Dashboard recovery", now: NOW });
    await harness.run("factory", "recover");
    assert.match(harness.notifications[1]?.message ?? "", /1 job\(s\) checked/);
    assert.match(harness.notifications[1]?.message ?? "", /every job matches its durable evidence/);
    assert.equal(harness.notifications[1]?.type, "info");
  } finally {
    await removeTempRepo(cwd);
  }
});
