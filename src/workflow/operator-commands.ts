/**
 * Operator commands with strict eligibility guards.
 *
 * Each command is a durable, history-preserving transition owned by the
 * extension. `approve`, `rework`, `retry`, `cancel`, and `promote` may only run
 * in the states documented in `skills/factory/references/state-machine.md`; an
 * ineligible request throws `CommandNotEligibleError` without touching the
 * board. Nothing here deletes branches, worktrees, PRs, or artifacts, and
 * `promote` only prepares a human-merged PR.
 */

import type { FactoryPolicy } from "../config/policy.ts";
import { loadPolicy } from "../config/policy.ts";
import type { Board, HistoryEntry, Job, PullRequest } from "../state/board.ts";
import { BoardStore } from "../state/board-store.ts";
import { appendJobEvent } from "../state/job-events.ts";
import { acquireLock, type LockHandle, type LockOptions } from "../state/lock.ts";
import { factoryPaths, jobPromotionLock, promotionTargetLock } from "../state/paths.ts";
import { CommandNotEligibleError, JobNotFoundError, OperatorRequestError } from "./errors.ts";
import {
  createGhPromotionAdapter,
  type PromotionAdapter,
  type PromotionTarget,
} from "./promotion/gh-adapter.ts";
import { retainRoundEvidence } from "./rounds.ts";

export const OPERATOR_COMMANDS = ["approve", "rework", "retry", "promote", "cancel"] as const;
export type OperatorCommand = (typeof OPERATOR_COMMANDS)[number];

export function isOperatorCommand(value: string): value is OperatorCommand {
  return (OPERATOR_COMMANDS as readonly string[]).includes(value);
}

/** Operator notes are untrusted text; bound them so a board cannot grow unbounded. */
export const MAX_OPERATOR_NOTE_LENGTH = 4000;

/** A history/event entry produced by an operator transition. */
export type OperatorEntry = HistoryEntry & { event: string };

export interface OperatorCommandResult {
  job: Job;
  board: Board;
}

export interface OperatorCommandInput {
  cwd: string;
  jobId: string;
  /** Optional operator guidance recorded verbatim in durable history. */
  note?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface CancelInput extends OperatorCommandInput {
  /**
   * Best-effort hook to stop active child work. The extension does not launch
   * subagents yet, so the default is a no-op; a host that does can pass a
   * stopper. A failure here aborts the cancellation without mutating state.
   */
  stopActiveWork?: (job: Job) => Promise<void>;
}

export interface PromoteInput extends OperatorCommandInput {
  /** Protected branch to promote to. Defaults to `main`. */
  target?: PromotionTarget;
  /** Injectable GitHub seam; defaults to the `gh` adapter. */
  adapter?: PromotionAdapter;
  lockOptions?: LockOptions;
}

export interface PromoteResult extends OperatorCommandResult {
  promotion: PullRequest;
}

/**
 * Resolve an approver `ESCALATE` with an explicit human approval and continue to
 * publication. The approver's decision and the human action are both retained.
 */
export async function approveJob(input: OperatorCommandInput): Promise<OperatorCommandResult> {
  return runTransition(input, "approve", {
    assertEligible: assertApprovable,
    entry: (job) => ({
      at: "",
      from: "approval",
      to: "publication",
      actor: "operator",
      event: "human_approved",
      round: job.round,
      note: normalizeNote("approve", input.note),
    }),
    effect: (job) => {
      job.approval = "APPROVE";
      job.stage = "publication";
      job.status = "active";
    },
  });
}

/**
 * Open the next numbered builder round from a human escalation, retaining the
 * closed round's evidence and recording the operator's guidance.
 */
export async function reworkJob(input: OperatorCommandInput): Promise<OperatorCommandResult> {
  const note = normalizeNote("rework", input.note);
  if (note === undefined) {
    throw new OperatorRequestError("rework", "a rework request requires an operator note describing what to change");
  }

  return runTransition(input, "rework", {
    assertEligible: assertReworkable,
    entry: (job) => ({
      at: "",
      from: job.stage,
      to: "build",
      actor: "operator",
      event: "human_rework",
      round: job.round,
      note,
    }),
    effect: async (job) => {
      // Retain the closed round before the resumed build overwrites the live
      // files, so `readReworkContext` can still see what the round found.
      await retainRoundEvidence(factoryPaths(input.cwd), job.id, job.round);
      job.round += 1;
      job.review_plan = null;
      job.stage = "build";
      job.status = "active";
    },
  });
}

/**
 * Clear a recoverable `blocked` condition so the stage can run again. Only
 * blocked jobs are eligible: `needs-human` means automation must not guess.
 */
export async function retryJob(input: OperatorCommandInput): Promise<OperatorCommandResult> {
  return runTransition(input, "retry", {
    assertEligible: assertRetryable,
    entry: (job) => ({
      at: "",
      from: job.stage,
      to: job.stage,
      actor: "operator",
      event: "human_retry",
      round: job.round,
      note: normalizeNote("retry", input.note),
    }),
    effect: (job) => {
      job.status = "active";
    },
  });
}

/**
 * Cancel a non-terminal job. Durable history, artifacts, branches, worktrees,
 * and PRs are preserved; only the status becomes `cancelled`.
 */
export async function cancelJob(input: CancelInput): Promise<OperatorCommandResult> {
  const store = new BoardStore(input.cwd);
  const board = await store.read();
  const job = findJob(board, input.jobId);
  assertCancellable(job);

  // Stop child work before recording the cancellation; a failure here leaves the
  // job untouched so the operator can retry the cancel.
  await input.stopActiveWork?.(job);

  return runTransition(input, "cancel", {
    assertEligible: assertCancellable,
    entry: (current) => ({
      at: "",
      from: current.stage,
      to: current.stage,
      actor: "operator",
      event: "job_cancelled",
      round: current.round,
      note: normalizeNote("cancel", input.note),
    }),
    effect: (current) => {
      current.status = "cancelled";
    },
  });
}

/**
 * Prepare a human-controlled promotion PR to a protected branch. Records the
 * promotion PR on the job; never merges, and never changes the job's own
 * publication PR.
 */
export async function promoteJob(input: PromoteInput): Promise<PromoteResult> {
  const paths = factoryPaths(input.cwd);
  const store = new BoardStore(input.cwd);
  const target: PromotionTarget = input.target ?? "main";

  const initial = await store.read();
  assertPromotable(findJob(initial, input.jobId));

  const lock = await acquireLock(jobPromotionLock(paths, input.jobId), input.lockOptions);
  // Promotion writes to a protected target branch shared by every job. The
  // per-target lock (taken after the per-job lock, always in that order) keeps
  // two jobs from preparing promotions to the same branch concurrently. It is
  // acquired inside the per-job lock's try so a contended target lock can
  // never leak the per-job lock the caller already holds.
  let targetLock: LockHandle | undefined;
  try {
    targetLock = await acquireLock(promotionTargetLock(paths, target), input.lockOptions);
    const board = await store.read();
    const job = findJob(board, input.jobId);
    assertPromotable(job);

    const policy: FactoryPolicy = await loadPolicy(input.cwd);
    const adapter = input.adapter ?? createGhPromotionAdapter();
    // The GitHub call happens before the board write: the PR must exist before
    // it can be recorded, and `preparePromotion` is idempotent, so an
    // interrupted or raced run reuses the same PR on the next attempt. The
    // expected version below makes that failure mode fail closed instead of
    // recording a promotion for state someone else has already changed.
    const promotion = await adapter.preparePromotion({ cwd: paths.root, job, policy, target });
    const expectedVersion = board.version;

    const at = (input.now ?? (() => new Date()))().toISOString();
    const { board: nextBoard, result } = await store.mutate(async (draft) => {
      const current = findJob(draft, input.jobId);
      assertPromotable(current);
      const entry: OperatorEntry = {
        at,
        from: "waiting_for_human",
        to: "waiting_for_human",
        actor: "operator",
        event: "promotion_prepared",
        round: current.round,
        note: normalizeNote("promote", input.note),
      };
      current.history.push(entry);
      await appendJobEvent(paths, current.id, entry);
      current.promotion = promotion;
      current.updated_at = at;
      return current;
    }, { expectedVersion });

    return { job: result, board: nextBoard, promotion };
  } finally {
    await targetLock?.release();
    await lock.release();
  }
}

interface TransitionSpec {
  assertEligible: (job: Job) => void;
  /** Build the history/event entry from the job as it is before the effect. */
  entry: (job: Job) => OperatorEntry;
  effect: (job: Job) => Promise<void> | void;
}

/**
 * Apply one guarded, history-preserving transition under the board lock.
 * Eligibility is checked twice: once for a fast, explicit error, and again
 * inside the lock so a racing writer cannot slip past the guard.
 */
async function runTransition(
  input: OperatorCommandInput,
  command: OperatorCommand,
  spec: TransitionSpec,
): Promise<OperatorCommandResult> {
  const store = new BoardStore(input.cwd);
  const paths = factoryPaths(input.cwd);

  const board = await store.read();
  spec.assertEligible(findJob(board, input.jobId));

  const at = (input.now ?? (() => new Date()))().toISOString();
  const { board: nextBoard, result } = await store.mutate(async (draft) => {
    const current = findJob(draft, input.jobId);
    spec.assertEligible(current);

    const entry = { ...spec.entry(current), at };
    await spec.effect(current);
    current.history.push(entry);
    await appendJobEvent(paths, current.id, entry);
    current.updated_at = at;
    return current;
  });

  return { job: result, board: nextBoard };
}

function findJob(board: Board, jobId: string): Job {
  const job = board.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new JobNotFoundError(jobId);
  return job;
}

function ineligible(command: OperatorCommand, job: Job, reason: string): never {
  throw new CommandNotEligibleError(command, job.id, reason, job.stage, job.status);
}

function assertApprovable(job: Job): void {
  if (job.status !== "needs-human") ineligible("approve", job, "the job is not waiting for a human decision");
  if (job.stage !== "approval") ineligible("approve", job, "the job is not at the approver gate");
  if (job.approval !== "ESCALATE") ineligible("approve", job, "the approver did not escalate");
}

function assertReworkable(job: Job): void {
  if (job.status !== "needs-human") ineligible("rework", job, "the job is not waiting for a human decision");
  if (job.stage !== "review" && job.stage !== "approval") {
    ineligible("rework", job, "only a review-exhausted or approver-escalated job can open a rework round");
  }
}

function assertRetryable(job: Job): void {
  if (job.status !== "blocked") ineligible("retry", job, "only a blocked job has a recoverable failure to retry");
}

function assertCancellable(job: Job): void {
  if (job.status === "cancelled" || job.status === "merged") {
    ineligible("cancel", job, `a ${job.status} job is terminal`);
  }
}

function assertPromotable(job: Job): void {
  if (job.status !== "needs-human" || job.stage !== "waiting_for_human") {
    ineligible("promote", job, "only a published job awaiting its human merge can prepare a promotion PR");
  }
  if (job.pull_request === null) ineligible("promote", job, "the job has no published pull request to promote");
}

function normalizeNote(command: OperatorCommand, note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = note.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_OPERATOR_NOTE_LENGTH) {
    throw new OperatorRequestError(command, `an operator note must be at most ${MAX_OPERATOR_NOTE_LENGTH} characters`);
  }
  return trimmed;
}
