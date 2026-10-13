import fs from "node:fs/promises";
import path from "node:path";
import { assertReviewComplete, type ParsedReview, type ReviewSeverity, type ReviewVerdict } from "../artifacts/review.ts";
import { writeFileAtomic } from "../state/atomic-write.ts";
import type { Board, Job, ReviewPlan } from "../state/board.ts";
import { BoardStore } from "../state/board-store.ts";
import { appendJobEvent } from "../state/job-events.ts";
import { acquireLock, type LockOptions } from "../state/lock.ts";
import { factoryPaths, jobBuildFile, jobReviewDir, jobReviewLock, jobReviewPlan, jobReviewReport } from "../state/paths.ts";
import { loadPolicy } from "../config/policy.ts";
import { InvalidJobStateError, JobNotFoundError } from "./errors.ts";

export interface ReviewerInput {
  cwd: string;
  job: Job;
  role: string;
  round: number;
  reportFile: string;
}

/** A reviewer owns exactly one report file and must not write application code. */
export type Reviewer = (input: ReviewerInput) => Promise<void>;
export type ReviewerMap = Record<string, Reviewer>;

export interface ReviewSelection {
  selected: string[];
  skipped: string[];
  reasons: Record<string, string>;
}

export interface RunReviewStageInput {
  cwd: string;
  jobId: string;
  reviewers: ReviewerMap;
  select?: (input: { job: Job; available: string[]; required: string[] }) => ReviewSelection;
  now?: () => Date;
  lockOptions?: LockOptions;
}

export interface ReviewResult {
  job: Job;
  board: Board;
  reports: Record<string, ParsedReview>;
}

export class ReviewIncompleteError extends Error {
  readonly reports: string[];
  constructor(reports: string[]) {
    super(`review round is incomplete; missing or invalid reports: ${reports.join(", ")}`);
    this.name = "ReviewIncompleteError";
    this.reports = reports;
  }
}

/** Run selected read-only reviewers and gate review -> approval or rework. */
export async function runReviewStage(input: RunReviewStageInput): Promise<ReviewResult> {
  const paths = factoryPaths(input.cwd);
  const store = new BoardStore(input.cwd);
  const initial = await store.read();
  const initialJob = initial.jobs.find((candidate) => candidate.id === input.jobId);
  if (!initialJob) throw new JobNotFoundError(input.jobId);
  assertReviewStage(initialJob);

  const lock = await acquireLock(jobReviewLock(paths, initialJob.id), input.lockOptions);
  try {
    const currentBoard = await store.read();
    const job = currentBoard.jobs.find((candidate) => candidate.id === input.jobId);
    if (!job) throw new JobNotFoundError(input.jobId);
    assertReviewStage(job);
    await fs.access(jobBuildFile(paths, job.id));
    const policy = await loadPolicy(input.cwd);
    const at = (input.now ?? (() => new Date()))().toISOString();
    let plan = job.review_plan;
    if (!plan) {
      plan = input.select?.({ job, available: policy.reviewers.available, required: policy.reviewers.required }) ?? defaultSelection(policy.reviewers.available, policy.reviewers.required, input.reviewers);
      validateSelection(plan, policy.reviewers.available, policy.reviewers.required);
      await store.mutate(async (draft) => {
        const current = draft.jobs.find((candidate) => candidate.id === job.id);
        if (!current) throw new JobNotFoundError(job.id);
        assertReviewStage(current);
        current.review_plan = plan;
        await writeFileAtomic(jobReviewPlan(paths, current.id), `${JSON.stringify(plan, null, 2)}\n`);
        current.updated_at = at;
        const entry = { at, from: "review" as const, to: "review" as const, actor: "factory", event: "review_started" };
        current.history.push(entry);
        await appendJobEvent(paths, current.id, entry);
      });
    }

    const reports: Record<string, ParsedReview> = {};
    const incomplete: string[] = [];
    await fs.mkdir(jobReviewDir(paths, job.id, job.round), { recursive: true });
    for (const role of plan.selected) {
      const reportFile = jobReviewReport(paths, job.id, job.round, role);
      const reviewer = input.reviewers[role];
      if (!reviewer) {
        incomplete.push(role);
        continue;
      }
      await reviewer({ cwd: paths.root, job, role, round: job.round, reportFile });
      try {
        reports[role] = assertReviewComplete(await fs.readFile(reportFile, "utf8"), reportFile);
      } catch {
        incomplete.push(role);
      }
    }
    if (incomplete.length > 0) throw new ReviewIncompleteError(incomplete);

    const blocking = Object.entries(reports).some(([, report]) => report.verdict === "CHANGES" && report.severity === "BLOCKING");
    const { board, result } = await store.mutate(async (draft) => {
      const current = draft.jobs.find((candidate) => candidate.id === job.id);
      if (!current) throw new JobNotFoundError(job.id);
      assertReviewStage(current);
      for (const [role, report] of Object.entries(reports)) current.verdicts[`${role}:round-${current.round}`] = report.verdict;
      const eventName = blocking ? (current.round >= policy.limits.max_review_rounds ? "review_exhausted" : "review_rework") : "review_complete";
      if (blocking && current.round < policy.limits.max_review_rounds) {
        await fs.copyFile(jobBuildFile(paths, current.id), path.join(jobReviewDir(paths, current.id, current.round), "build.md"));
      }
      const to = blocking && current.round < policy.limits.max_review_rounds ? "build" as const : blocking ? "review" as const : "approval" as const;
      const entry = { at, from: "review" as const, to, actor: "factory", event: eventName };
      current.history.push(entry);
      await appendJobEvent(paths, current.id, entry);
      current.updated_at = at;
      if (!blocking) current.stage = "approval";
      else if (current.round < policy.limits.max_review_rounds) { current.round += 1; current.stage = "build"; current.review_plan = null; }
      else current.status = "needs-human";
      return current;
    });
    return { job: result, board, reports };
  } finally {
    await lock.release();
  }
}

function defaultSelection(available: string[], required: string[], reviewers: ReviewerMap): ReviewSelection {
  const selected = (required.length > 0 ? required : available).filter((role) => reviewers[role]);
  const skipped = available.filter((role) => !selected.includes(role));
  const reasons = Object.fromEntries(skipped.map((role) => [role, reviewers[role] ? "Not selected by orchestrator" : "No reviewer adapter configured"])) as Record<string, string>;
  return { selected, skipped, reasons };
}

function validateSelection(plan: ReviewSelection, available: string[], required: string[]): void {
  for (const role of available) if (!/^[A-Za-z0-9_-]+$/.test(role)) throw new Error(`reviewer role ${role} is not safe for an artifact path`);
  const all = new Set(available);
  if (new Set([...plan.selected, ...plan.skipped]).size !== available.length || plan.selected.some((role) => !all.has(role)) || plan.skipped.some((role) => !all.has(role))) {
    throw new Error("review selection must classify every available reviewer exactly once");
  }
  if (required.some((role) => !plan.selected.includes(role))) throw new Error("required reviewers cannot be skipped");
  for (const role of plan.skipped) if (!plan.reasons[role]?.trim()) throw new Error(`skipped reviewer ${role} requires a reason`);
}

function assertReviewStage(job: Job): void {
  if (job.stage !== "review" || job.status !== "active") throw new InvalidJobStateError(job.id, "stage review with status active", job.stage, job.status);
}

export type { ReviewSeverity, ReviewVerdict, ReviewPlan };
