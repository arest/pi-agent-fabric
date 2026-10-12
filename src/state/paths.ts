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
