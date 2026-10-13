import fs from "node:fs/promises";
import type { Board, Job } from "../state/board.ts";
import { BoardStore } from "../state/board-store.ts";
import { loadPolicy, policySnapshot } from "../config/policy.ts";
import { allocateJobId } from "../state/job-id.ts";
import { appendJobEvent } from "../state/job-events.ts";
import { factoryPaths, jobDir } from "../state/paths.ts";
import { redactSecrets } from "../security/sanitize.ts";

/** Thrown when a start request has no usable feature text. */
export class InvalidFeatureError extends Error {
  constructor() {
    super("a feature request is required to start a factory job");
    this.name = "InvalidFeatureError";
  }
}

export interface StartJobInput {
  /** Repository root the job belongs to. */
  cwd: string;
  /** Raw feature request text (untrusted). */
  feature: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface StartJobResult {
  job: Job;
  board: Board;
  boardFile: string;
  jobDir: string;
}

/**
 * Create a new factory job scaffold.
 *
 * This is the first durable workflow step: it validates repository policy before
 * allocating a job id or creating any durable artifacts, then creates the job
 * scaffold and appends an `active`/`spec` job to the extension-owned board.
 * Specification, build, review, approval, and publication stages are implemented
 * by later tickets; no reviewers or approval flow run here.
 */
export async function startJob(input: StartJobInput): Promise<StartJobResult> {
  const feature = redactSecrets(input.feature).trim();
  if (feature.length === 0) throw new InvalidFeatureError();

  // This must remain before BoardStore construction/mutation: invalid policy is
  // a fail-closed startup error with no board, lock, or job-artifact side effect.
  const policy = await loadPolicy(input.cwd);
  const snapshot = policySnapshot(policy);
  const now = input.now ?? ((): Date => new Date());
  const timestamp = now().toISOString();
  const store = new BoardStore(input.cwd);
  const paths = factoryPaths(input.cwd);

  let createdDir: string | null = null;
  try {
    const { board, result } = await store.mutate(async (draft) => {
      const id = allocateJobId(draft, feature);
      const dir = jobDir(paths, id);

      await fs.mkdir(dir, { recursive: true });
      createdDir = dir;

      // One source of truth for the creation facts, shared by the job event
      // log and the board history entry.
      const jobCreated = {
        at: timestamp,
        from: null,
        to: "spec" as const,
        actor: "factory",
        event: "job_created",
        round: 1,
      };
      await appendJobEvent(paths, id, jobCreated);

      const job: Job = {
        id,
        feature,
        policy: snapshot,
        mode: policy.target_mode,
        branch: `factory/${id}`,
        target: "develop",
        stage: "spec",
        status: "active",
        round: 1,
        review_plan: null,
        verdicts: {},
        approval: null,
        pull_request: null,
        promotion: null,
        created_at: timestamp,
        updated_at: timestamp,
        history: [jobCreated],
      };
      draft.jobs.push(job);
      return job;
    });

    return {
      job: result,
      board,
      boardFile: store.paths.boardFile,
      jobDir: jobDir(paths, result.id),
    };
  } catch (error) {
    if (createdDir !== null) {
      await fs.rm(createdDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}
