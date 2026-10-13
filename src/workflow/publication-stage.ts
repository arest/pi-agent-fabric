import { loadPolicy } from "../config/policy.ts";
import type { Board, Job, PullRequest } from "../state/board.ts";
import { BoardStore } from "../state/board-store.ts";
import { appendJobEvent } from "../state/job-events.ts";
import { acquireLock, type LockOptions } from "../state/lock.ts";
import { factoryPaths, jobBranchLock, jobPublicationLock } from "../state/paths.ts";
import { InvalidJobStateError, JobNotFoundError } from "./errors.ts";
import { createGhPublicationAdapter, type PublicationAdapter } from "./publication/gh-adapter.ts";

export interface RunPublicationStageInput {
  cwd: string;
  jobId: string;
  adapter?: PublicationAdapter;
  now?: () => Date;
  lockOptions?: LockOptions;
}

export interface PublicationResult {
  job: Job;
  board: Board;
  pullRequest: PullRequest;
}

/**
 * Publish an approved job through the configured GitHub adapter and stop at
 * waiting-for-human. The factory never auto-merges or mutates branch
 * protection.
 */
export async function runPublicationStage(input: RunPublicationStageInput): Promise<PublicationResult> {
  const paths = factoryPaths(input.cwd);
  const store = new BoardStore(input.cwd);

  const initial = await store.read();
  const initialJob = initial.jobs.find((candidate) => candidate.id === input.jobId);
  if (!initialJob) throw new JobNotFoundError(input.jobId);
  assertPublicationStage(initialJob);

  const lock = await acquireLock(jobPublicationLock(paths, initialJob.id), input.lockOptions);
  try {
    const board = await store.read();
    const job = board.jobs.find((candidate) => candidate.id === input.jobId);
    if (!job) throw new JobNotFoundError(input.jobId);
    assertPublicationStage(job);

    const policy = await loadPolicy(input.cwd);
    if (policy.target !== job.target) {
      throw new Error(`policy target ${policy.target} does not match job target ${job.target}`);
    }

    const adapter = input.adapter ?? createGhPublicationAdapter();
    await adapter.preflight({ cwd: paths.root, job, policy });
    // Pushing the job branch mutates a shared branch. The per-job branch lock
    // serializes it against branch/worktree creation in the build stage, so a
    // push never races a concurrently resumed builder on the same job.
    const branchLock = await acquireLock(jobBranchLock(paths, job.id), input.lockOptions);
    let pullRequest: PullRequest;
    try {
      pullRequest = await adapter.ensurePullRequest({ cwd: paths.root, job, policy });
    } finally {
      await branchLock.release();
    }

    const at = (input.now ?? (() => new Date()))().toISOString();
    const { board: nextBoard, result } = await store.mutate(async (draft) => {
      const current = draft.jobs.find((candidate) => candidate.id === job.id);
      if (!current) throw new JobNotFoundError(job.id);
      assertPublicationStage(current);

      const entry = {
        at,
        from: "publication" as const,
        to: "waiting_for_human" as const,
        actor: "factory",
        event: "publication_complete",
        round: current.round,
      };
      current.history.push(entry);
      await appendJobEvent(paths, current.id, entry);
      current.stage = "waiting_for_human";
      current.status = "needs-human";
      current.pull_request = pullRequest;
      current.updated_at = at;
      return current;
    });

    return { job: result, board: nextBoard, pullRequest };
  } finally {
    await lock.release();
  }
}

function assertPublicationStage(job: Job): void {
  if (job.stage !== "publication" || job.status !== "active" || job.approval !== "APPROVE") {
    throw new InvalidJobStateError(
      job.id,
      "stage publication with status active and approval APPROVE",
      job.stage,
      job.status,
    );
  }
}

export type { PublicationAdapter };
