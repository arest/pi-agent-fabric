/**
 * Restart recovery: reconcile the board against durable evidence.
 *
 * On restart the board is the claimed state; the durable evidence is the job
 * artifacts on disk, Git, and GitHub. Recovery walks every job, compares the
 * recorded stage against that evidence, and resumes each job from the last safe
 * durable stage:
 *
 * - artifacts a stage requires are checked where they live;
 * - partial review reports are incomplete, never passes;
 * - when the board and the evidence disagree, the job escalates to a human
 *   instead of guessing;
 * - nothing is deleted: history, artifacts, branches, and PRs are preserved.
 *
 * Runs are serialized by a recovery lock, and the resulting board write is
 * guarded by the board's version, so a concurrent writer fails closed instead
 * of recording reconciliations for state someone else already changed.
 */

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertDecisionComplete } from "../artifacts/decision.ts";
import { assertReviewComplete, type ReviewVerdict } from "../artifacts/review.ts";
import { rolesWithVerdicts } from "../artifacts/review.ts";
import { describeCause } from "./errors.ts";import type { ApprovalDecision, Board, Job, JobStatus, PullRequest, Stage } from "../state/board.ts";
import { BoardStore } from "../state/board-store.ts";
import { appendJobEvent } from "../state/job-events.ts";
import { acquireLock, type LockOptions } from "../state/lock.ts";
import {
  factoryPaths,
  factoryRecoveryLock,
  jobBuildFile,
  jobDecisionFile,
  jobReviewPlan,
  jobReviewReport,
  jobSpecFile,
  type FactoryPaths,
} from "../state/paths.ts";

const execFileAsync = promisify(execFile);

export type PullRequestState = "open" | "merged" | "closed";

/** Git evidence seam. The default shells out to `git`; tests inject fakes. */
export interface GitEvidenceAdapter {
  branchExists(input: { cwd: string; branch: string }): Promise<boolean>;
}

/**
 * GitHub evidence seam. `null` means no pull request could be found; a failing
 * lookup throws and is reported as unavailable. The recorded `pull_request` is
 * passed so the adapter can query the exact PR the board recorded instead of
 * guessing it from the branch.
 */
export interface GitHubEvidenceAdapter {
  pullRequestState(input: { cwd: string; pullRequest: PullRequest; head: string; base: string }): Promise<PullRequestState | null>;
}

/** Default Git evidence: a branch exists when `git show-ref --verify` succeeds. */
export const gitEvidenceAdapter: GitEvidenceAdapter = {
  async branchExists({ cwd, branch }) {
    try {
      await execFileAsync("git", ["show-ref", "--verify", `refs/heads/${branch}`], { cwd });
      return true;
    } catch {
      return false;
    }
  },
};

/** Default GitHub evidence: `gh pr view <recorded url>` resolves the PR's state. */
export const githubEvidenceAdapter: GitHubEvidenceAdapter = {
  async pullRequestState({ cwd, pullRequest }) {
    try {
      const result = await execFileAsync("gh", ["pr", "view", pullRequest.url, "--json", "state"], { cwd });
      const state = (JSON.parse(result.stdout) as { state?: unknown }).state;
      if (state === "OPEN" || state === "MERGED" || state === "CLOSED") {
        return state.toLowerCase() as PullRequestState;
      }
      return null;
    } catch {
      return null;
    }
  },
};

/** What recovery decided to do with a job. */
export type RecoveryAction = "unchanged" | "reconciled" | "merged";

export interface JobRecoveryOutcome {
  jobId: string;
  stage: Stage;
  status: JobStatus;
  action: RecoveryAction;
  /** Why recovery touched (or left) the job, phrased for the operator. */
  reason: string;
}

export interface RunRecoveryInput {
  cwd: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  git?: GitEvidenceAdapter;
  github?: GitHubEvidenceAdapter;
  /** Injectable lock timing for hosts and deterministic contention tests. */
  lockOptions?: LockOptions;
}

export interface RecoveryResult {
  board: Board;
  outcomes: JobRecoveryOutcome[];
}

interface Reconciliation {
  stage?: Stage;
  status?: JobStatus;
  approval?: ApprovalDecision | null;
  reason: string;
}

/**
 * Reconcile every job on the board with its durable evidence.
 *
 * Terminal, `blocked`, and `failed` jobs are left exactly as they are: their
 * state was written by a guarded transition or a recorded factory stop, and
 * only an operator command (`retry`, `rework`, `cancel`) may change it. Active
 * jobs resume from the last stage whose required evidence is complete, and a
 * published job whose PR was merged on GitHub is recorded as merged.
 */
export async function runRecoveryStage(input: RunRecoveryInput): Promise<RecoveryResult> {
  const paths = factoryPaths(input.cwd);
  const store = new BoardStore(input.cwd);
  const git = input.git ?? gitEvidenceAdapter;
  const github = input.github ?? githubEvidenceAdapter;
  const now = input.now ?? ((): Date => new Date());

  const lock = await acquireLock(factoryRecoveryLock(paths), input.lockOptions);
  try {
    const board = await store.read();

    // Analyze against this exact board revision, then fail closed if a
    // concurrent writer changed the board before the reconciled write lands.
    const outcomes: JobRecoveryOutcome[] = [];
    const reconciliations = new Map<string, Reconciliation>();
    for (const job of board.jobs) {
      const reconciliation = await reconcileJob(paths, job, { cwd: paths.root, git, github });
      if (reconciliation === null) {
        outcomes.push({ jobId: job.id, stage: job.stage, status: job.status, action: "unchanged", reason: "the board matches the durable evidence" });
        continue;
      }
      reconciliations.set(job.id, reconciliation);
      const stage = reconciliation.stage ?? job.stage;
      const status = reconciliation.status ?? job.status;
      outcomes.push({ jobId: job.id, stage, status, action: status === "merged" ? "merged" : "reconciled", reason: reconciliation.reason });
    }

    if (reconciliations.size === 0) {
      return { board, outcomes };
    }

    const at = now().toISOString();
    const { board: nextBoard } = await store.mutate(async (draft) => {
      for (let index = 0; index < draft.jobs.length; index += 1) {
        const job = draft.jobs[index];
        if (!job) continue;
        const reconciliation = reconciliations.get(job.id);
        if (!reconciliation) continue;
        const entry = {
          at,
          from: job.stage,
          to: reconciliation.stage ?? job.stage,
          actor: "factory",
          event: "recovered",
          round: job.round,
        };
        await appendJobEvent(paths, job.id, entry);
        job.history.push(entry);
        if (reconciliation.stage !== undefined) job.stage = reconciliation.stage;
        if (reconciliation.status !== undefined) job.status = reconciliation.status;
        if (reconciliation.approval !== undefined) job.approval = reconciliation.approval;
        job.updated_at = at;
      }
      return draft;
    }, { expectedVersion: board.version });

    return { board: nextBoard, outcomes };
  } finally {
    await lock.release();
  }
}

const STAGE_ORDER: Stage[] = ["spec", "build", "review", "approval", "publication", "waiting_for_human"];

function atOrAfter(stage: Stage, threshold: Stage): boolean {
  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(threshold);
}

/** Shared evidence seams for one reconciliation pass. */
interface EvidenceAdapters {
  cwd: string;
  git: GitEvidenceAdapter;
  github: GitHubEvidenceAdapter;
}

async function reconcileJob(
  paths: FactoryPaths,
  job: Job,
  evidence: EvidenceAdapters,
): Promise<Reconciliation | null> {
  // Terminal and non-resumable statuses are deliberate durable decisions.
  if (job.status !== "active" && job.status !== "needs-human") return null;

  // A published job can complete without any operator: GitHub is the merge
  // authority, so a merged PR is durable evidence of a finished job.
  if (job.stage === "waiting_for_human") return reconcileWaitingForHuman(job, evidence);

  if (job.status !== "active") return null;

  // The spec stage legitimately has no artifact yet; nothing to reconcile.
  if (job.stage === "spec") return null;

  // Every later stage requires the spec artifact to still be readable.
  if (!(await isReadable(jobSpecFile(paths, job.id)))) {
    return { stage: "spec", reason: "spec.md is missing or unreadable; the job resumes at the spec stage" };
  }

  // Every stage from review on requires the build evidence of this round.
  if (atOrAfter(job.stage, "review") && !(await isReadable(jobBuildFile(paths, job.id)))) {
    return { stage: "build", reason: "build.md is missing or unreadable; the job resumes at the build stage" };
  }

  // From review on, the job's branch is durable Git evidence of started work.
  if (atOrAfter(job.stage, "review") && !(await evidence.git.branchExists({ cwd: evidence.cwd, branch: job.branch }))) {
    return { status: "needs-human", reason: `branch ${job.branch} is missing from Git while the board records stage ${job.stage}` };
  }

  if (atOrAfter(job.stage, "review")) {
    const reviewProblem = await reconcileReviewRound(paths, job);
    if (reviewProblem !== null) return reviewProblem;
  }

  if (atOrAfter(job.stage, "publication")) {
    const approvalProblem = await reconcileApproval(paths, job);
    if (approvalProblem !== null) return approvalProblem;
  }

  return null;
}

/**
 * A recorded PR can only be judged against GitHub. A merged PR ends the job;
 * anything else that disagrees with the board escalates to a human.
 */
async function reconcileWaitingForHuman(
  job: Job,
  evidence: EvidenceAdapters,
): Promise<Reconciliation | null> {
  if (job.pull_request === null) {
    return { status: "needs-human", reason: "the job is published but no pull request is recorded on the board" };
  }

  let state: PullRequestState | null;
  try {
    state = await evidence.github.pullRequestState({ cwd: evidence.cwd, pullRequest: job.pull_request, head: job.branch, base: job.target });
  } catch (error) {
    return { status: "needs-human", reason: `GitHub evidence is unavailable: ${describeCause(error)}` };
  }

  if (state === "merged") {
    return { status: "merged", reason: "the recorded pull request was merged on GitHub; the job is complete" };
  }
  if (state === "open") {
    if (job.status === "needs-human") return null;
    return { status: "needs-human", reason: "the pull request is open and awaiting its human merge" };
  }
  if (state === "closed") {
    return { status: "needs-human", reason: "the recorded pull request is closed without a merge; a human must decide" };
  }
  return { status: "needs-human", reason: "the recorded pull request was not found on GitHub" };
}

/**
 * Review evidence must be coherent for the stage it gates: a verdict recorded
 * for a reviewer whose report cannot be read is a disagreement (the report may
 * have been lost or corrupted), while a missing report with no recorded verdict
 * is simply an incomplete round to resume at review.
 */
async function reconcileReviewRound(paths: FactoryPaths, job: Job): Promise<Reconciliation | null> {
  if (job.review_plan === null) {
    if (job.stage === "review") return null;
    return { status: "needs-human", reason: "the review plan for the current round is missing" };
  }

  const verdicts = currentRoundVerdictRoles(job);
  for (const role of job.review_plan.selected) {
    const report = await readReviewReport(paths, job, role);
    if (report !== null) continue;
    if (verdicts.has(role)) {
      return { status: "needs-human", reason: `a verdict was recorded for ${role} but the report cannot be read` };
    }
    if (job.stage !== "review") {
      return { stage: "review", reason: `the current round's report for ${role} is missing or invalid; the job resumes at review` };
    }
  }
  return null;
}

/**
 * Approval evidence must match the recorded decision at the publication stage
 * and beyond. The decision artifact is the durable source, so it can restore a
 * lost board approval — and an `ESCALATE` artifact always wins, because a
 * human decision may never be overwritten by automation.
 */
async function reconcileApproval(paths: FactoryPaths, job: Job): Promise<Reconciliation | null> {
  let parsed;
  try {
    parsed = assertDecisionComplete(await fs.readFile(jobDecisionFile(paths, job.id), "utf8"), jobDecisionFile(paths, job.id));
  } catch {
    return {
      stage: "approval",
      status: "needs-human",
      reason: "decision.md is missing or unreadable at the publication stage; a human must confirm the approval",
    };
  }

  if (parsed.decision === "ESCALATE") {
    if (job.approval === "ESCALATE") return null;
    return {
      stage: "approval",
      approval: "ESCALATE",
      status: "needs-human",
      reason: "decision.md records ESCALATE; the job returns to the approver gate",
    };
  }

  if (job.approval === "APPROVE") return null;
  return {
    approval: "APPROVE",
    status: "active",
    reason: "decision.md records APPROVE; the approval was restored from the durable artifact",
  };
}

function currentRoundVerdictRoles(job: Job): Set<string> {
  return rolesWithVerdicts(job.verdicts, job.round);
}

async function readReviewReport(paths: FactoryPaths, job: Job, role: string): Promise<ReviewVerdict | null> {
  const file = jobReviewReport(paths, job.id, job.round, role);
  try {
    return (await assertReviewComplete(await fs.readFile(file, "utf8"), file)).verdict;
  } catch {
    return null;
  }
}

async function isReadable(filePath: string): Promise<boolean> {
  try {
    await fs.readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}
