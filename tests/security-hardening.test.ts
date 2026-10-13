import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { createGhToolkit } from "../src/workflow/gh.ts";
import { runApprovalStage, type Approver } from "../src/workflow/approval-stage.ts";
import { runBuildStage } from "../src/workflow/build-stage.ts";
import { reworkJob } from "../src/workflow/operator-commands.ts";
import { runReviewStage } from "../src/workflow/review-stage.ts";
import { runSpecStage } from "../src/workflow/spec-stage.ts";
import { startJob } from "../src/workflow/start-job.ts";
import {
  approveDecision,
  completeSpecMarkdown,
  configureFactory,
  evidenceBuilder,
  makeTempRepo,
  passReviewer,
  readBoard,
  readJobEvents,
  removeTempRepo,
  stubWorktreeProvider,
} from "./helpers/harness.ts";

const NOW = (): Date => new Date("2026-02-03T04:05:06.000Z");

async function seedApprovalEscalation(cwd: string): Promise<string> {
  await configureFactory(cwd);
  const { job } = await startJob({ cwd, feature: "Security hardening round", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  await runBuildStage({
    cwd,
    jobId: job.id,
    builder: evidenceBuilder,
    worktree: stubWorktreeProvider(cwd),
    now: NOW,
    runValidation: async (command) => ({ ...command, outcome: "PASS" as const }),
  });
  await runReviewStage({ cwd, jobId: job.id, reviewers: { code: passReviewer }, now: NOW });
  const approver: Approver = async ({ decisionFile }) => {
    await fs.writeFile(
      decisionFile,
      approveDecision.replace("DECISION: APPROVE", "DECISION: ESCALATE").replace("Acceptance criteria are covered by tests.", "Needs explicit human confirmation."),
    );
  };
  await runApprovalStage({ cwd, jobId: job.id, approver, now: NOW });
  return job.id;
}

test("startJob redacts secret-looking feature text before persisting", async () => {
  const cwd = await makeTempRepo();
  try {
    const secret = "sk-test-1234567890abcdefghijklmnop";
    const { job } = await startJob({ cwd, feature: `Integrate provider key ${secret}`, now: NOW });

    assert.ok(!job.feature.includes(secret), "job.feature must not persist plaintext secrets");
    assert.match(job.feature, /\[REDACTED\]/);

    const board = await readBoard(cwd);
    assert.ok(!board.jobs[0]!.feature.includes(secret), "board.json must not persist plaintext secrets");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("operator notes are redacted before writing board history and events", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApprovalEscalation(cwd);
    const secret = "ghp_123456789012345678901234567890123456";

    await reworkJob({ cwd, jobId, note: `Rotate leaked token ${secret} immediately`, now: NOW });

    const board = await readBoard(cwd);
    const historyNote = board.jobs[0]!.history.at(-1)?.note ?? "";
    assert.ok(!historyNote.includes(secret), "board history note must redact plaintext secrets");
    assert.match(historyNote, /\[REDACTED\]/);

    const eventNote = (await readJobEvents(cwd, jobId)).at(-1)?.note ?? "";
    assert.ok(!eventNote.includes(secret), "events.jsonl note must redact plaintext secrets");
    assert.match(eventNote, /\[REDACTED\]/);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("the gh toolkit denies dangerous git/gh actions with an explicit policy violation", async () => {
  const gh = createGhToolkit((message) => new Error(message));

  await assert.rejects(() => gh.run(process.cwd(), "git", ["reset", "--hard"]), /policy violation/i);
  await assert.rejects(() => gh.run(process.cwd(), "git", ["push", "--force", "origin", "main"]), /policy violation/i);
  await assert.rejects(
    () => gh.gh(process.cwd(), ["api", "repos/owner/repo/branches/main/protection", "-X", "DELETE"]),
    /policy violation/i,
  );
});

test("gh command errors are redacted before being surfaced", async () => {
  const gh = createGhToolkit((message) => new Error(message));
  const secret = "sk-test-abcdef1234567890abcdef1234567890";

  await assert.rejects(
    () => gh.run(process.cwd(), "node", ["-e", `process.stderr.write('token ${secret}'); process.exit(1);`]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(secret), "error message must redact plaintext secrets");
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});
