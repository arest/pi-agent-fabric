import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { SpecContractError } from "../src/artifacts/spec.ts";
import { InvalidJobStateError, JobNotFoundError, SpecNotFoundError } from "../src/workflow/errors.ts";
import { runSpecStage, type SpecWriter } from "../src/workflow/spec-stage.ts";
import { startJob } from "../src/workflow/start-job.ts";
import {
  completeSpecMarkdown,
  jobSpecPath,
  makeTempRepo,
  readBoard,
  readJobEvents,
  removeTempRepo,
} from "./helpers/harness.ts";

const FIXED_NOW = (): Date => new Date("2026-01-02T03:04:05.000Z");

function writerWith(markdown: string): SpecWriter {
  return async ({ specFile }) => {
    await fs.writeFile(specFile, markdown, "utf8");
  };
}

async function seedJob(cwd: string): Promise<string> {
  const { job } = await startJob({ cwd, feature: "Add rate limiting to the public API", now: FIXED_NOW });
  return job.id;
}

test("a complete spec advances the job from spec to build with durable history", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedJob(cwd);
    const before = await readBoard(cwd);

    const result = await runSpecStage({
      cwd,
      jobId,
      writer: writerWith(completeSpecMarkdown()),
      now: FIXED_NOW,
    });

    assert.equal(result.job.stage, "build");
    assert.equal(result.job.status, "active");
    assert.equal(result.job.updated_at, FIXED_NOW().toISOString());
    assert.equal(result.specFile, jobSpecPath(cwd, jobId));
    assert.equal(result.parsed.missing.length, 0);
    assert.deepEqual(result.job.history.at(-1), {
      at: FIXED_NOW().toISOString(),
      from: "spec",
      to: "build",
      actor: "factory",
      event: "spec_complete",
    });

    const after = await readBoard(cwd);
    assert.ok(after.version > before.version, "the transition must bump the board version");
    assert.equal(after.jobs[0]?.stage, "build");

    const events = await readJobEvents(cwd, jobId);
    assert.deepEqual(
      events.map((event) => event.event),
      ["job_created", "spec_complete"],
    );
    assert.equal(events.at(-1)?.to, "build");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("the default writer scaffolds spec.md and the empty scaffold cannot advance", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedJob(cwd);

    await assert.rejects(
      () => runSpecStage({ cwd, jobId, now: FIXED_NOW }),
      (error: unknown) => error instanceof SpecContractError,
    );

    const scaffold = await fs.readFile(jobSpecPath(cwd, jobId), "utf8");
    for (const heading of ["Problem", "Scope", "Acceptance criteria", "Validation commands", "Risks and assumptions"]) {
      assert.match(scaffold, new RegExp(`^## ${heading}$`, "m"));
    }

    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.stage, "spec", "an incomplete spec must not advance the job");
    const events = await readJobEvents(cwd, jobId);
    assert.deepEqual(
      events.map((event) => event.event),
      ["job_created"],
      "a failed spec gate must not record a spec_complete event",
    );
  } finally {
    await removeTempRepo(cwd);
  }
});

test("the default writer never overwrites an existing specification", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedJob(cwd);
    await fs.writeFile(jobSpecPath(cwd, jobId), completeSpecMarkdown(), "utf8");

    const result = await runSpecStage({ cwd, jobId, now: FIXED_NOW });
    assert.equal(result.job.stage, "build");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a missing required section fails closed and leaves the board untouched", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedJob(cwd);
    const before = await readBoard(cwd);

    const partial = completeSpecMarkdown({ Problem: "", "Validation commands": "   " });
    await assert.rejects(
      () => runSpecStage({ cwd, jobId, writer: writerWith(partial), now: FIXED_NOW }),
      (error: unknown) => {
        assert.ok(error instanceof SpecContractError);
        assert.deepEqual(error.missing, ["Problem", "Validation commands"]);
        return true;
      },
    );

    const after = await readBoard(cwd);
    assert.equal(after.version, before.version, "a rejected spec must not mutate the board");
    assert.equal(after.jobs[0]?.stage, "spec");
    assert.equal(after.jobs[0]?.history.length, 1);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a writer that produces no artifact fails with SpecNotFoundError", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedJob(cwd);
    const before = await readBoard(cwd);

    await assert.rejects(
      () => runSpecStage({ cwd, jobId, writer: async () => {}, now: FIXED_NOW }),
      SpecNotFoundError,
    );

    const after = await readBoard(cwd);
    assert.equal(after.version, before.version);
    assert.equal(after.jobs[0]?.stage, "spec");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("a writer failure propagates without mutating the board", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedJob(cwd);
    const before = await readBoard(cwd);

    await assert.rejects(
      () =>
        runSpecStage({
          cwd,
          jobId,
          writer: async () => {
            throw new Error("writer unavailable");
          },
          now: FIXED_NOW,
        }),
      /writer unavailable/,
    );

    const after = await readBoard(cwd);
    assert.equal(after.version, before.version);
    assert.equal(after.jobs[0]?.stage, "spec");
  } finally {
    await removeTempRepo(cwd);
  }
});

test("re-running the stage after a successful transition is rejected and not duplicated", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedJob(cwd);
    await runSpecStage({ cwd, jobId, writer: writerWith(completeSpecMarkdown()), now: FIXED_NOW });

    await assert.rejects(
      () => runSpecStage({ cwd, jobId, writer: writerWith(completeSpecMarkdown()), now: FIXED_NOW }),
      InvalidJobStateError,
    );

    const board = await readBoard(cwd);
    const specEvents = board.jobs[0]?.history.filter((entry) => entry.event === "spec_complete") ?? [];
    assert.equal(specEvents.length, 1);

    const events = await readJobEvents(cwd, jobId);
    assert.equal(events.filter((event) => event.event === "spec_complete").length, 1);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("concurrent stage runs advance the job exactly once", async () => {
  const cwd = await makeTempRepo();
  try {
    const jobId = await seedJob(cwd);
    const writer: SpecWriter = async ({ specFile }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fs.writeFile(specFile, completeSpecMarkdown(), "utf8");
    };

    const results = await Promise.allSettled([
      runSpecStage({ cwd, jobId, writer, now: FIXED_NOW }),
      runSpecStage({ cwd, jobId, writer, now: FIXED_NOW }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof InvalidJobStateError);

    const board = await readBoard(cwd);
    assert.equal(board.jobs[0]?.stage, "build");
    assert.equal(board.jobs[0]?.history.filter((entry) => entry.event === "spec_complete").length, 1);

    const events = await readJobEvents(cwd, jobId);
    assert.equal(events.filter((event) => event.event === "spec_complete").length, 1);
  } finally {
    await removeTempRepo(cwd);
  }
});

test("an unknown job id is rejected before any artifact is touched", async () => {
  const cwd = await makeTempRepo();
  try {
    await seedJob(cwd);
    await assert.rejects(
      () => runSpecStage({ cwd, jobId: "999-missing", writer: writerWith(completeSpecMarkdown()) }),
      JobNotFoundError,
    );
  } finally {
    await removeTempRepo(cwd);
  }
});
