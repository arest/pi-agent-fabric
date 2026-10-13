import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runApprovalStage, type Approver } from "../src/workflow/approval-stage.ts";
import { runBuildStage, type Builder, type WorktreeProvider } from "../src/workflow/build-stage.ts";
import { runReviewStage, type Reviewer } from "../src/workflow/review-stage.ts";
import { runSpecStage } from "../src/workflow/spec-stage.ts";
import { startJob } from "../src/workflow/start-job.ts";
import { completeSpecMarkdown, makeTempRepo, readBoard, readJobEvents, removeTempRepo } from "./helpers/harness.ts";

const NOW = (): Date => new Date("2026-02-03T04:05:06.000Z");
const provider = (cwd: string): WorktreeProvider => ({ prepare: async () => ({ path: cwd, lockPath: path.join(cwd, "builder.lock") }) });
const builder: Builder = async ({ buildFile }) =>
  fs.writeFile(buildFile, "## Changed files\n\n- src/example.ts\n\n## Validation\n\n- PASS\n\n## Remaining risks\n\nNone\n");
const passReviewer: Reviewer = async ({ reportFile, role }) =>
  fs.writeFile(
    reportFile,
    `# ${role}\n\nVERDICT: PASS\nSEVERITY: NON-BLOCKING\n\n## Summary\n\nLooks good.\n\n## Findings\n\nNone.\n\n## Evidence\n\nInspected diff.\n\n## Recommendations\n\nNone.\n`,
  );

async function seedApproval(cwd: string): Promise<string> {
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".pi", "factory.json"),
    JSON.stringify({ schema_version: 1, reviewers: { available: ["code"], required: ["code"] } }),
  );
  const { job } = await startJob({ cwd, feature: "Add approver gate", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  await runBuildStage({ cwd, jobId: job.id, builder, worktree: provider(cwd), now: NOW, runValidation: async (command) => ({ ...command, outcome: "PASS" as const }) });
  await runReviewStage({ cwd, jobId: job.id, reviewers: { code: passReviewer }, now: NOW });
  return job.id;
}

test("APPROVE persists independently from reviewer verdicts and advances to publication", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApproval(cwd);
    const seen: { reportRoles: string[]; target?: string } = { reportRoles: [] };
    const approver: Approver = async ({ decisionFile, reviewReports, policy }) => {
      seen.reportRoles = Object.keys(reviewReports);
      seen.target = policy.target;
      await fs.writeFile(
        decisionFile,
        "DECISION: APPROVE\n\n## Spec checks\n\nAcceptance criteria are covered by tests.\n\n## Implementation evidence\n\nDiff and build evidence are in scope.\n\n## Policy context\n\nTarget remains develop with human merge required.\n",
      );
    };

    const result = await runApprovalStage({ cwd, jobId, approver, now: NOW });

    assert.equal(result.job.stage, "publication");
    assert.equal(result.job.status, "active");
    assert.equal(result.job.approval, "APPROVE");
    assert.deepEqual(result.job.verdicts, { "code:round-1": "PASS" });
    assert.deepEqual(seen.reportRoles, ["code"]);
    assert.equal(seen.target, "develop");

    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.approval, "APPROVE");
    assert.equal((await readJobEvents(cwd, jobId)).at(-1)?.event, "approval_complete");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("ESCALATE persists and marks the job as human-needed", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApproval(cwd);
    const approver: Approver = async ({ decisionFile }) => {
      await fs.writeFile(
        decisionFile,
        "DECISION: ESCALATE\n\n## Spec checks\n\nScope and acceptance criteria conflict.\n\n## Implementation evidence\n\nDiff does not prove safe rollout.\n\n## Policy context\n\nRisk requires human decision.\n",
      );
    };

    const result = await runApprovalStage({ cwd, jobId, approver, now: NOW });
    assert.equal(result.job.stage, "approval");
    assert.equal(result.job.status, "needs-human");
    assert.equal(result.job.approval, "ESCALATE");
    assert.equal((await readJobEvents(cwd, jobId)).at(-1)?.event, "approval_escalated");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("invalid decision evidence fails closed without advancing state", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedApproval(cwd);
    const approver: Approver = async ({ decisionFile }) => {
      await fs.writeFile(decisionFile, "DECISION: APPROVE\n\n## Spec checks\n\nDone.\n");
    };

    await assert.rejects(() => runApprovalStage({ cwd, jobId, approver, now: NOW }), /incomplete/);

    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.stage, "approval");
    assert.equal(board.jobs[0]?.status, "active");
    assert.equal(board.jobs[0]?.approval, null);
  } finally {
    await removeTempRepo(cwd);
  }
});
