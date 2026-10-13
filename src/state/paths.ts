import path from "node:path";

/**
 * Filesystem layout owned by the factory extension.
 *
 * All paths are derived from the consumer repository root (`cwd`) so the
 * package stays repository-agnostic.
 */
export interface FactoryPaths {
  /** Repository root. */
  root: string;
  /** `factory/` — durable factory artifacts. */
  factoryDir: string;
  /** `factory/board.json` — durable board state, written only by the extension. */
  boardFile: string;
  /** `factory/.board.lock` — board write lock. */
  boardLockFile: string;
  /** `factory/jobs/` — per-job artifact directories. */
  jobsDir: string;
  /** `factory/worktrees/` — isolated builder worktrees. */
  worktreesDir: string;
}

export function factoryPaths(cwd: string): FactoryPaths {
  const root = path.resolve(cwd);
  const factoryDir = path.join(root, "factory");
  return {
    root,
    factoryDir,
    boardFile: path.join(factoryDir, "board.json"),
    boardLockFile: path.join(factoryDir, ".board.lock"),
    jobsDir: path.join(factoryDir, "jobs"),
    worktreesDir: path.join(factoryDir, "worktrees"),
  };
}

export function jobDir(paths: FactoryPaths, jobId: string): string {
  return path.join(paths.jobsDir, jobId);
}

export function jobEventsFile(paths: FactoryPaths, jobId: string): string {
  return path.join(jobDir(paths, jobId), "events.jsonl");
}

/** `factory/jobs/<job-id>/spec.md` — the spec-writer's specification artifact. */
export function jobSpecFile(paths: FactoryPaths, jobId: string): string {
  return path.join(jobDir(paths, jobId), "spec.md");
}

/** `factory/jobs/<job-id>/build.md` — the builder's evidence artifact. */
export function jobBuildFile(paths: FactoryPaths, jobId: string): string {
  return path.join(jobDir(paths, jobId), "build.md");
}

/** `factory/jobs/<job-id>/decision.md` — the approver's durable decision artifact. */
export function jobDecisionFile(paths: FactoryPaths, jobId: string): string {
  return path.join(jobDir(paths, jobId), "decision.md");
}

export function jobWorktree(paths: FactoryPaths, jobId: string): string {
  return path.join(paths.worktreesDir, jobId);
}

export function jobReviewPlan(paths: FactoryPaths, jobId: string): string {
  return path.join(jobDir(paths, jobId), "review-plan.json");
}

export function jobReviewDir(paths: FactoryPaths, jobId: string, round: number): string {
  return path.join(jobDir(paths, jobId), `round-${round}`);
}

export function jobReviewReport(paths: FactoryPaths, jobId: string, round: number, role: string): string {
  return path.join(jobReviewDir(paths, jobId, round), `review-${role}.md`);
}

/**
 * `round-<n>/build.md` — the build evidence that the round reviewed, retained
 * when the round closes so a later rework overwrites only the live `build.md`.
 */
export function jobRoundBuildFile(paths: FactoryPaths, jobId: string, round: number): string {
  return path.join(jobReviewDir(paths, jobId, round), "build.md");
}

/**
 * `round-<n>/review-plan.json` — the reviewer selection that ran in the round,
 * retained so a rework round's plan does not erase the previous round's.
 */
export function jobRoundReviewPlan(paths: FactoryPaths, jobId: string, round: number): string {
  return path.join(jobReviewDir(paths, jobId, round), "review-plan.json");
}

export function jobReviewLock(paths: FactoryPaths, jobId: string): string {
  return path.join(jobDir(paths, jobId), ".review.lock");
}

export function jobApprovalLock(paths: FactoryPaths, jobId: string): string {
  return path.join(jobDir(paths, jobId), ".approval.lock");
}

export function jobPublicationLock(paths: FactoryPaths, jobId: string): string {
  return path.join(jobDir(paths, jobId), ".publication.lock");
}

/**
 * `factory/jobs/<job-id>/.promotion.lock` — serializes `/factory promote` so a
 * concurrent request cannot prepare a second promotion PR for the same job.
 */
export function jobPromotionLock(paths: FactoryPaths, jobId: string): string {
  return path.join(jobDir(paths, jobId), ".promotion.lock");
}
