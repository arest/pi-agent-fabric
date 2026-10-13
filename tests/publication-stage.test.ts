import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runApprovalStage, type Approver } from "../src/workflow/approval-stage.ts";
import { runBuildStage, type Builder, type WorktreeProvider } from "../src/workflow/build-stage.ts";
import { runPublicationStage, type PublicationAdapter } from "../src/workflow/publication-stage.ts";
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

async function seedPublication(cwd: string): Promise<string> {
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".pi", "factory.json"),
    JSON.stringify({ schema_version: 1, reviewers: { available: ["code"], required: ["code"] } }),
  );
  const { job } = await startJob({ cwd, feature: "Publish approved work", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  await runBuildStage({ cwd, jobId: job.id, builder, worktree: provider(cwd), now: NOW, runValidation: async (command) => ({ ...command, outcome: "PASS" as const }) });
  await runReviewStage({ cwd, jobId: job.id, reviewers: { code: passReviewer }, now: NOW });

  const approver: Approver = async ({ decisionFile }) => {
    await fs.writeFile(
      decisionFile,
      "DECISION: APPROVE\n\n## Spec checks\n\nAcceptance criteria are covered by tests.\n\n## Implementation evidence\n\nDiff and build evidence are in scope.\n\n## Policy context\n\nTarget remains develop with human merge required.\n",
    );
  };
  await runApprovalStage({ cwd, jobId: job.id, approver, now: NOW });
  return job.id;
}

test("publication preflight and PR publication move the job to waiting-for-human", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublication(cwd);

    const calls: string[] = [];
    const adapter: PublicationAdapter = {
      async preflight() {
        calls.push("preflight");
      },
      async ensurePullRequest() {
        calls.push("ensure-pr");
        return {
          url: "https://github.com/arest/pi-agent-fabric/pull/123",
          state: "OPEN",
          merge_state: "WAITING_FOR_HUMAN",
        };
      },
    };

    const result = await runPublicationStage({ cwd, jobId, adapter, now: NOW });

    assert.deepEqual(calls, ["preflight", "ensure-pr"]);
    assert.equal(result.job.stage, "waiting_for_human");
    assert.equal(result.job.status, "needs-human");
    assert.equal(result.job.pull_request?.url, "https://github.com/arest/pi-agent-fabric/pull/123");
    assert.equal(result.job.pull_request?.merge_state, "WAITING_FOR_HUMAN");

    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.stage, "waiting_for_human");
    assert.equal((await readJobEvents(cwd, jobId)).at(-1)?.event, "publication_complete");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("preflight failures fail closed without mutating publication state", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedPublication(cwd);

    const adapter: PublicationAdapter = {
      async preflight() {
        throw new Error("auth missing");
      },
      async ensurePullRequest() {
        throw new Error("must not be called");
      },
    };

    await assert.rejects(() => runPublicationStage({ cwd, jobId, adapter, now: NOW }), /auth missing/);

    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.stage, "publication");
    assert.equal(board.jobs[0]?.status, "active");
    assert.equal(board.jobs[0]?.pull_request, null);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("publication rejects jobs that were not approved", async () => {
  const cwd = await makeTempRepo();
  try {
    await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
    const { job } = await startJob({ cwd, feature: "Wrong stage", now: NOW });

    const adapter: PublicationAdapter = {
      async preflight() {},
      async ensurePullRequest() {
        return { url: "https://example.com/pr/1", state: "OPEN", merge_state: "WAITING_FOR_HUMAN" };
      },
    };

    await assert.rejects(
      () => runPublicationStage({ cwd, jobId: job.id, adapter, now: NOW }),
      /expected stage publication with status active and approval APPROVE/,
    );
  } finally {
    await removeTempRepo(cwd);
  }
});
