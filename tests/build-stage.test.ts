import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { BuildEvidenceError } from "../src/artifacts/build.ts";
import { runBuildStage, type Builder, type WorktreeProvider } from "../src/workflow/build-stage.ts";
import { acquireLock } from "../src/state/lock.ts";
import { startJob } from "../src/workflow/start-job.ts";
import { runSpecStage } from "../src/workflow/spec-stage.ts";
import { completeSpecMarkdown, makeTempRepo, readBoard, readJobEvents, removeTempRepo } from "./helpers/harness.ts";
import path from "node:path";

const NOW = (): Date => new Date("2026-02-03T04:05:06.000Z");

async function seedBuild(cwd: string): Promise<string> {
  const { job } = await startJob({ cwd, feature: "Add a builder", now: NOW });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, completeSpecMarkdown()), now: NOW });
  return job.id;
}

function provider(cwd: string): WorktreeProvider {
  return { prepare: async () => ({ path: cwd, lockPath: path.join(cwd, "builder.lock") }) };
}

function builderWith(body = "src/example.ts"): Builder {
  return async ({ buildFile }) => {
    await fs.writeFile(buildFile, `## Changed files\n\n- ${body}\n\n## Validation\n\nplaceholder\n\n## Remaining risks\n\nNone.\n`);
  };
}

test("builder captures evidence and advances build to review", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedBuild(cwd);
    const result = await runBuildStage({
      cwd,
      jobId,
      builder: builderWith(),
      worktree: provider(cwd),
      now: NOW,
      runValidation: async (command) => ({ ...command, outcome: "PASS" }),
    });
    assert.equal(result.job.stage, "review");
    assert.equal((await readBoard(cwd)).jobs[0]?.stage, "review");
    assert.match(await fs.readFile(result.buildFile, "utf8"), /Add a builder|Validation/);
    assert.deepEqual((await readJobEvents(cwd, jobId)).map((event) => event.event), ["job_created", "spec_complete", "build_complete"]);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("configured validation outcomes are persisted in build evidence", async () => {
  const cwd = await makeTempRepo();
  try {
    await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".pi", "factory.json"), JSON.stringify({
      schema_version: 1,
      repository: { test_commands: [{ name: "unit", command: "node --version" }] },
    }));
    const jobId = await seedBuild(cwd);
    const result = await runBuildStage({
      cwd,
      jobId,
      builder: builderWith(),
      worktree: provider(cwd),
      now: NOW,
      runValidation: async (command) => ({ ...command, outcome: "PASS", output: "ok" }),
    });
    assert.equal(result.validation[0]?.outcome, "PASS");
    assert.match(await fs.readFile(result.buildFile, "utf8"), /unit: PASS/);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("incomplete build evidence fails closed and blocks the job", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedBuild(cwd);
    await assert.rejects(
      () => runBuildStage({ cwd, jobId, builder: async ({ buildFile }) => fs.writeFile(buildFile, "## Changed files\n\n- x\n"), worktree: provider(cwd), now: NOW }),
      BuildEvidenceError,
    );
    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.stage, "build");
    assert.equal(board.jobs[0]?.status, "blocked");
    assert.match(board.jobs[0]?.history.at(-1)?.event ?? "", /build_failed:incomplete_evidence/);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("lock timeout leaves the active job unchanged", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedBuild(cwd);
    const held = await acquireLock(path.join(cwd, "builder.lock"));
    try {
      const before = await readBoard(cwd);
      await assert.rejects(
        () => runBuildStage({ cwd, jobId, builder: builderWith(), worktree: provider(cwd), lockOptions: { timeoutMs: 5, pollMs: 1 } }),
        /timed out.*builder.lock/,
      );
      const after = await readBoard(cwd);
      assert.equal(after.version, before.version);
      assert.equal(after.jobs[0]?.status, "active");
      assert.equal(after.jobs[0]?.stage, "build");
    } finally {
      await held.release();
    }
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a second concurrent builder cannot become an application writer", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedBuild(cwd);
    let calls = 0;
    const slowBuilder: Builder = async ({ buildFile }) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await fs.writeFile(buildFile, "## Changed files\n\n- x\n\n## Validation\n\n- ok\n\n## Remaining risks\n\nNone.\n");
    };
    const options = { cwd, jobId, worktree: provider(cwd), now: NOW, runValidation: async (command: { name: string; command: string }) => ({ ...command, outcome: "PASS" as const }) };
    const results = await Promise.allSettled([
      runBuildStage({ ...options, builder: slowBuilder }),
      runBuildStage({ ...options, builder: slowBuilder }),
    ]);
    assert.equal(calls, 1);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await readBoard(cwd)).jobs[0]?.stage, "review");
  } finally {
    await removeTempRepo(cwd);
  }
});
