import fs from "node:fs/promises";
import path from "node:path";
import { assertSpecComplete, renderSpecTemplate, type ParsedSpec } from "../artifacts/spec.ts";
import type { Board, Job } from "../state/board.ts";
import { BoardStore } from "../state/board-store.ts";
import { appendJobEvent, readJobEvents } from "../state/job-events.ts";
import { factoryPaths, jobSpecFile } from "../state/paths.ts";
import { InvalidJobStateError, JobNotFoundError, SpecNotFoundError } from "./errors.ts";

export interface SpecWriterInput {
  /** Repository root the job belongs to. */
  cwd: string;
  /** The job whose specification is being written. */
  job: Job;
  /** Absolute path of the artifact the spec-writer owns. */
  specFile: string;
}

/**
 * The spec-writer role seam.
 *
 * The role is stable; the runtime that implements it (a Pi subagent, the
 * current operator, a provider) is configuration. The writer owns `spec.md`;
 * the extension only validates the artifact and records the transition.
 */
export type SpecWriter = (input: SpecWriterInput) => Promise<void>;

/**
 * Default writer: create the contract scaffold when `spec.md` is absent and
 * never overwrite an existing specification. The scaffold's empty sections do
 * not satisfy the contract, so running the stage alone cannot advance a job.
 */
export const scaffoldSpecWriter: SpecWriter = async ({ job, specFile }) => {
  try {
    await fs.mkdir(path.dirname(specFile), { recursive: true });
    await fs.writeFile(specFile, renderSpecTemplate(job.feature), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
};

export interface RunSpecStageInput {
  /** Repository root the job belongs to. */
  cwd: string;
  /** Job id from the board. */
  jobId: string;
  /** Role adapter. Defaults to the scaffold writer. */
  writer?: SpecWriter;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface RunSpecStageResult {
  job: Job;
  board: Board;
  /** Absolute path of the validated specification. */
  specFile: string;
  /** Contract parse result that gated the transition. */
  parsed: ParsedSpec;
}

/**
 * Run the specification stage for one job and advance `spec -> build`.
 *
 * The stage is fail-closed and ordered so that no durable state changes until
 * the artifact is complete:
 *
 * 1. read the board and require the job to be `spec`/`active`;
 * 2. let the writer role produce its `spec.md`;
 * 3. validate the artifact against the required-section contract;
 * 4. under the board lock, re-check the stage, append a `spec_complete` event,
 *    and transition the job to `build`.
 *
 * A missing or incomplete specification throws and leaves the board at `spec`,
 * so a later attempt can resume without duplicating history.
 */
export async function runSpecStage(input: RunSpecStageInput): Promise<RunSpecStageResult> {
  const store = new BoardStore(input.cwd);
  const paths = factoryPaths(input.cwd);
  const now = input.now ?? ((): Date => new Date());

  const board = await store.read();
  const job = board.jobs.find((candidate) => candidate.id === input.jobId);
  if (!job) throw new JobNotFoundError(input.jobId);
  assertSpecStage(job);

  const specFile = jobSpecFile(paths, job.id);
  const writer = input.writer ?? scaffoldSpecWriter;
  await writer({ cwd: paths.root, job, specFile });

  const markdown = await readSpecFile(specFile);
  const parsed = assertSpecComplete(markdown);
  const at = now().toISOString();

  const { board: nextBoard, result: nextJob } = await store.mutate(async (draft) => {
    const current = draft.jobs.find((candidate) => candidate.id === job.id);
    if (!current) throw new JobNotFoundError(job.id);
    assertSpecStage(current);

    const events = await readJobEvents(paths, current.id);
    const entry = { at, from: "spec" as const, to: "build" as const, actor: "factory", event: "spec_complete" };
    if (!events.some((event) => event.event === entry.event)) {
      await appendJobEvent(paths, current.id, entry);
    }

    current.history.push(entry);
    current.stage = "build";
    current.updated_at = at;
    return current;
  });

  return { job: nextJob, board: nextBoard, specFile, parsed };
}

function assertSpecStage(job: Job): void {
  if (job.stage !== "spec" || job.status !== "active") {
    throw new InvalidJobStateError(job.id, "stage spec with status active", job.stage, job.status);
  }
}

async function readSpecFile(specFile: string): Promise<string> {
  try {
    return await fs.readFile(specFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SpecNotFoundError(specFile);
    throw error;
  }
}
