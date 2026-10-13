/**
 * Durable board model.
 *
 * The board is the factory's canonical record of job state. It is written only
 * by the extension (see `board-store.ts`); child roles write their own job
 * artifacts and never mutate this file.
 */

import { isValidRound } from "./round.ts";

/** Shape version of the board document. Bump with a migration when fields change. */
export const BOARD_SCHEMA_VERSION = 1;

/**
 * Where a job is in the workflow. Kept separate from `status` (durable outcome)
 * and from verdicts (report results).
 */
export const STAGES = [
  "spec",
  "build",
  "review",
  "approval",
  "publication",
  "waiting_for_human",
] as const;
export type Stage = (typeof STAGES)[number];

/** Durable job outcome. Kept separate from the workflow stage. */
export const JOB_STATUSES = [
  "active",
  "blocked",
  "needs-human",
  "merged",
  "cancelled",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Publication mode. The core release supports `develop` only; the aggregator
 * module is deferred and must not be enabled implicitly.
 */
export type Mode = "develop";

export interface ReviewPlan {
  selected: string[];
  skipped: string[];
  reasons: Record<string, string>;
}

export interface PullRequest {
  url: string;
  state: string;
  merge_state: string;
}

export interface HistoryEntry {
  at: string;
  from: Stage | null;
  to: Stage;
  actor: string;
  /**
   * Optional so that boards written to the documented `{at, from, to, actor}`
   * shape still load. The factory always records it.
   */
  event?: string;
  /**
   * Review round the transition belongs to. Optional for the same compatibility
   * reason as `event`; the factory records it so numbered rework rounds keep a
   * distinct, auditable history even when they repeat an event name.
   */
  round?: number;
}

export interface JobPolicySnapshot {
  v: 1;
  source: "default" | "repo";
  mode: Mode;
  target: string;
}

export type ApprovalDecision = "APPROVE" | "ESCALATE";

export interface Job {
  id: string;
  feature: string;
  policy?: JobPolicySnapshot;
  mode: Mode;
  branch: string;
  target: string;
  stage: Stage;
  status: JobStatus;
  round: number;
  review_plan: ReviewPlan | null;
  verdicts: Record<string, string>;
  approval: ApprovalDecision | null;
  pull_request: PullRequest | null;
  created_at: string;
  updated_at: string;
  history: HistoryEntry[];
}

export interface Board {
  schema_version: number;
  /** Monotonic write counter used for optimistic concurrency checks. */
  version: number;
  jobs: Job[];
}

export class BoardIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardIntegrityError";
  }
}

export function createEmptyBoard(): Board {
  return { schema_version: BOARD_SCHEMA_VERSION, version: 0, jobs: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

function parseHistory(value: unknown, jobId: string): HistoryEntry[] {
  if (!Array.isArray(value)) {
    throw new BoardIntegrityError(`job ${jobId} has a non-array history`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new BoardIntegrityError(`job ${jobId} history[${index}] is not an object`);
    }
    const { at, to, actor, event, round } = entry;
    const from = entry.from;
    if (typeof at !== "string" || typeof actor !== "string") {
      throw new BoardIntegrityError(`job ${jobId} history[${index}] is missing required text fields`);
    }
    if (event !== undefined && typeof event !== "string") {
      throw new BoardIntegrityError(`job ${jobId} history[${index}] has a non-text event`);
    }
    if (round !== undefined && !isValidRound(round)) {
      throw new BoardIntegrityError(`job ${jobId} history[${index}] has an invalid round`);
    }
    if (!isStage(to) || !(from === null || isStage(from))) {
      throw new BoardIntegrityError(`job ${jobId} history[${index}] has an invalid stage`);
    }
    return { at, from: from as Stage | null, to, actor, event, round: round as number | undefined };
  });
}

function parseReviewPlan(value: unknown, jobId: string): ReviewPlan | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new BoardIntegrityError(`job ${jobId} review_plan is not an object`);
  }
  const { selected, skipped, reasons } = value;
  if (!isStringArray(selected) || !isStringArray(skipped) || !isStringRecord(reasons)) {
    throw new BoardIntegrityError(`job ${jobId} review_plan has invalid selected/skipped/reasons`);
  }
  return { selected, skipped, reasons };
}

function parsePolicySnapshot(value: unknown, jobId: string): JobPolicySnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.v !== 1 || (value.source !== "default" && value.source !== "repo") || value.mode !== "develop" || value.target !== "develop") {
    throw new BoardIntegrityError(`job ${jobId} has an invalid policy snapshot`);
  }
  return { v: 1, source: value.source, mode: "develop", target: value.target };
}

function parseApproval(value: unknown, jobId: string): ApprovalDecision | null {
  if (value === null || value === undefined) return null;
  if (value !== "APPROVE" && value !== "ESCALATE") {
    throw new BoardIntegrityError(`job ${jobId} has an invalid approval decision`);
  }
  return value;
}

function parsePullRequest(value: unknown, jobId: string): PullRequest | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new BoardIntegrityError(`job ${jobId} pull_request is not an object`);
  }
  const { url, state, merge_state: mergeState } = value;
  if (typeof url !== "string" || typeof state !== "string" || typeof mergeState !== "string") {
    throw new BoardIntegrityError(`job ${jobId} pull_request is missing required text fields`);
  }
  return { url, state, merge_state: mergeState };
}

function parseJob(value: unknown, index: number): Job {
  if (!isRecord(value)) {
    throw new BoardIntegrityError(`jobs[${index}] is not an object`);
  }
  const id = value.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new BoardIntegrityError(`jobs[${index}] has no id`);
  }
  const { feature, mode, branch, target, round, created_at: createdAt, updated_at: updatedAt } = value;
  if (
    typeof feature !== "string" ||
    typeof branch !== "string" ||
    typeof target !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new BoardIntegrityError(`job ${id} is missing required text fields`);
  }
  if (mode !== "develop") {
    throw new BoardIntegrityError(`job ${id} has unsupported mode ${String(mode)}`);
  }
  if (!isValidRound(round)) {
    throw new BoardIntegrityError(`job ${id} has an invalid round`);
  }
  if (!isStage(value.stage)) {
    throw new BoardIntegrityError(`job ${id} has an invalid stage`);
  }
  if (!isJobStatus(value.status)) {
    throw new BoardIntegrityError(`job ${id} has an invalid status`);
  }
  const verdicts = value.verdicts ?? {};
  if (!isStringRecord(verdicts)) {
    throw new BoardIntegrityError(`job ${id} verdicts is not a string map`);
  }
  return {
    id,
    feature,
    policy: parsePolicySnapshot(value.policy, id),
    mode: "develop",
    branch,
    target,
    stage: value.stage,
    status: value.status,
    round,
    review_plan: parseReviewPlan(value.review_plan, id),
    verdicts,
    approval: parseApproval(value.approval, id),
    pull_request: parsePullRequest(value.pull_request, id),
    created_at: createdAt,
    updated_at: updatedAt,
    history: parseHistory(value.history, id),
  };
}

/**
 * Validate an unknown value as a `Board`. Unknown schema versions fail closed so
 * a newer board is never silently downgraded or rewritten by an older writer.
 */
export function parseBoard(value: unknown): Board {
  if (!isRecord(value)) {
    throw new BoardIntegrityError("board is not an object");
  }
  if (value.schema_version !== BOARD_SCHEMA_VERSION) {
    throw new BoardIntegrityError(
      `unsupported board schema_version ${String(value.schema_version)} (expected ${BOARD_SCHEMA_VERSION})`,
    );
  }
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 0) {
    throw new BoardIntegrityError("board version must be a non-negative integer");
  }
  if (!Array.isArray(value.jobs)) {
    throw new BoardIntegrityError("board jobs must be an array");
  }
  const jobs = value.jobs.map((job, index) => parseJob(job, index));
  const ids = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.id)) {
      throw new BoardIntegrityError(`duplicate job id ${job.id}`);
    }
    ids.add(job.id);
  }
  return { schema_version: BOARD_SCHEMA_VERSION, version: value.version, jobs };
}
