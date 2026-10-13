import fs from "node:fs/promises";
import { assertDecisionComplete, type ApprovalDecision, type ParsedDecision } from "../artifacts/decision.ts";
import { assertReviewComplete, type ParsedReview } from "../artifacts/review.ts";
import { loadPolicy, type FactoryPolicy } from "../config/policy.ts";
import type { Board, Job } from "../state/board.ts";
import { BoardStore } from "../state/board-store.ts";
import { appendJobEvent } from "../state/job-events.ts";
import { acquireLock, type LockOptions } from "../state/lock.ts";
import {
  factoryPaths,
  jobApprovalLock,
  jobBuildFile,
  jobDecisionFile,
  jobReviewReport,
  jobSpecFile,
} from "../state/paths.ts";
import { InvalidJobStateError, JobNotFoundError, SpecNotFoundError } from "./errors.ts";

export interface ApproverInput {
  cwd: string;
  job: Job;
  specFile: string;
  buildFile: string;
  decisionFile: string;
  reviewReports: Record<string, { file: string; report: ParsedReview }>;
  policy: FactoryPolicy;
  round: number;
}

/** The approver owns only decision.md and must not write application code. */
export type Approver = (input: ApproverInput) => Promise<void>;

export interface RunApprovalStageInput {
  cwd: string;
  jobId: string;
  approver: Approver;
  now?: () => Date;
  lockOptions?: LockOptions;
}

export interface ApprovalResult {
  job: Job;
  board: Board;
  decision: ParsedDecision;
  decisionFile: string;
}

/** Run the independent approver gate and transition approval -> publication/escalation. */
export async function runApprovalStage(input: RunApprovalStageInput): Promise<ApprovalResult> {
  const paths = factoryPaths(input.cwd);
  const store = new BoardStore(input.cwd);

  const initial = await store.read();
  const initialJob = initial.jobs.find((candidate) => candidate.id === input.jobId);
  if (!initialJob) throw new JobNotFoundError(input.jobId);
  assertApprovalStage(initialJob);

  const lock = await acquireLock(jobApprovalLock(paths, initialJob.id), input.lockOptions);
  try {
    const board = await store.read();
    const job = board.jobs.find((candidate) => candidate.id === input.jobId);
    if (!job) throw new JobNotFoundError(input.jobId);
    assertApprovalStage(job);

    const specFile = jobSpecFile(paths, job.id);
    const buildFile = jobBuildFile(paths, job.id);
    const decisionFile = jobDecisionFile(paths, job.id);
    await assertReadable(specFile, () => new SpecNotFoundError(specFile));
    await assertReadable(buildFile, () => new Error(`build.md was not found at ${buildFile}`));

    const reviewReports: Record<string, { file: string; report: ParsedReview }> = {};
    for (const role of job.review_plan?.selected ?? []) {
      const file = jobReviewReport(paths, job.id, job.round, role);
      await assertReadable(file, () => new Error(`review report for ${role} was not found at ${file}`));
      const markdown = await fs.readFile(file, "utf8");
      reviewReports[role] = { file, report: assertReviewComplete(markdown, file) };
    }

    const policy = await loadPolicy(input.cwd);
    await input.approver({
      cwd: paths.root,
      job,
      specFile,
      buildFile,
      decisionFile,
      reviewReports,
      policy,
      round: job.round,
    });

    const decision = assertDecisionComplete(await fs.readFile(decisionFile, "utf8"), decisionFile);
    const at = (input.now ?? (() => new Date()))().toISOString();
    const { board: nextBoard, result } = await store.mutate(async (draft) => {
      const current = draft.jobs.find((candidate) => candidate.id === job.id);
      if (!current) throw new JobNotFoundError(job.id);
      assertApprovalStage(current);

      const event = decision.decision === "APPROVE" ? "approval_complete" : "approval_escalated";
      const to = decision.decision === "APPROVE" ? ("publication" as const) : ("approval" as const);
      const entry = { at, from: "approval" as const, to, actor: "factory", event, round: current.round };
      current.history.push(entry);
      await appendJobEvent(paths, current.id, entry);
      current.approval = decision.decision;
      current.updated_at = at;
      if (decision.decision === "APPROVE") {
        current.stage = "publication";
      } else {
        current.status = "needs-human";
      }
      return current;
    });

    return { job: result, board: nextBoard, decision, decisionFile };
  } finally {
    await lock.release();
  }
}

function assertApprovalStage(job: Job): void {
  if (job.stage !== "approval" || job.status !== "active") {
    throw new InvalidJobStateError(job.id, "stage approval with status active", job.stage, job.status);
  }
}

async function assertReadable(file: string, errorFactory: () => Error): Promise<void> {
  try {
    await fs.access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw errorFactory();
    throw error;
  }
}

export type { ApprovalDecision, FactoryPolicy };
