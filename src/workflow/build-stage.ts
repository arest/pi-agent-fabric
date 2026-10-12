import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertBuildComplete } from "../artifacts/build.ts";
import type { Board, Job } from "../state/board.ts";
import { BoardStore } from "../state/board-store.ts";
import { appendJobEvent, readJobEvents } from "../state/job-events.ts";
import { acquireLock, LockTimeoutError, type LockHandle } from "../state/lock.ts";
import { factoryPaths, jobBuildFile, jobSpecFile, jobWorktree } from "../state/paths.ts";
import { InvalidJobStateError, JobNotFoundError, SpecNotFoundError } from "./errors.ts";
import { loadPolicy, type FactoryPolicy } from "../config/policy.ts";

const execFileAsync = promisify(execFile);

export interface ValidationResult {
  name: string;
  command: string;
  outcome: "PASS" | "FAIL";
  output?: string;
}

export interface BuilderInput {
  cwd: string;
  worktree: string;
  specFile: string;
  buildFile: string;
  job: Job;
  validation: ValidationResult[];
}

/** The builder owns application code and build.md, never the board. */
export type Builder = (input: BuilderInput) => Promise<void>;

export interface WorktreeProvider {
  prepare(input: { cwd: string; job: Job }): Promise<{ path: string; lockPath: string }>;
}

/** Default provider creates one branch worktree per job. */
export const gitWorktreeProvider: WorktreeProvider = {
  async prepare({ cwd, job }) {
    const paths = factoryPaths(cwd);
    const worktree = jobWorktree(paths, job.id);
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    try {
      await fs.access(path.join(worktree, ".git"));
    } catch {
      const branchExists = await execFileAsync("git", ["show-ref", "--verify", `refs/heads/${job.branch}`], { cwd }).then(() => true).catch(() => false);
      const args = branchExists
        ? ["worktree", "add", worktree, job.branch]
        : ["worktree", "add", "-b", job.branch, worktree, "HEAD"];
      await execFileAsync("git", args, { cwd });
    }
    return { path: worktree, lockPath: path.join(worktree, ".factory-builder.lock") };
  },
};

export interface RunBuildStageInput {
  cwd: string;
  jobId: string;
  builder: Builder;
  worktree?: WorktreeProvider;
  now?: () => Date;
  runValidation?: (command: { name: string; command: string }, cwd: string) => Promise<ValidationResult>;
}

export interface RunBuildStageResult {
  job: Job;
  board: Board;
  worktree: string;
  buildFile: string;
  validation: ValidationResult[];
}

/** Run build work under a worktree-level writer lock and gate build -> review. */
export async function runBuildStage(input: RunBuildStageInput): Promise<RunBuildStageResult> {
  const paths = factoryPaths(input.cwd);
  const store = new BoardStore(input.cwd);
  const initial = await store.read();
  const job = initial.jobs.find((candidate) => candidate.id === input.jobId);
  if (!job) throw new JobNotFoundError(input.jobId);
  assertBuildStage(job);
  try {
    await fs.access(jobSpecFile(paths, job.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SpecNotFoundError(jobSpecFile(paths, job.id));
    throw error;
  }

  const policy = await loadPolicy(input.cwd);
  const prepared = await (input.worktree ?? gitWorktreeProvider).prepare({ cwd: input.cwd, job });
  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(prepared.lockPath);
    const lockedBoard = await store.read();
    const lockedJob = lockedBoard.jobs.find((candidate) => candidate.id === job.id);
    if (!lockedJob) throw new JobNotFoundError(job.id);
    assertBuildStage(lockedJob);
    const runValidation = input.runValidation ?? runConfiguredValidation;
    const validation: ValidationResult[] = [];
    const buildFile = jobBuildFile(paths, job.id);
    await input.builder({
      cwd: paths.root,
      worktree: prepared.path,
      specFile: jobSpecFile(paths, job.id),
      buildFile,
      job,
      validation,
    });
    for (const command of policy.repository.test_commands) {
      const result = await runValidation(command, prepared.path);
      validation.push(result);
      await mergeValidationEvidence(buildFile, validation);
      if (result.outcome === "FAIL") {
        await recordBuildFailure(store, paths, job.id, input.now, `validation_failed:${command.name}`);
        throw new BuildFailedError(job.id, `validation command ${command.name} failed`);
      }
    }
    await mergeValidationEvidence(buildFile, validation);
    const evidence = await fs.readFile(buildFile, "utf8");
    assertBuildComplete(evidence);
    const at = (input.now ?? (() => new Date()))().toISOString();
    const { board, result } = await store.mutate(async (draft) => {
      const current = draft.jobs.find((candidate) => candidate.id === job.id);
      if (!current) throw new JobNotFoundError(job.id);
      assertBuildStage(current);
      const entry = { at, from: "build" as const, to: "review" as const, actor: "factory", event: "build_complete" };
      const events = await readJobEvents(paths, current.id);
      if (!events.some((event) => event.event === entry.event)) await appendJobEvent(paths, current.id, entry);
      current.history.push(entry);
      current.stage = "review";
      current.updated_at = at;
      return current;
    });
    return { job: result, board, worktree: prepared.path, buildFile, validation };
  } catch (error) {
    if (error instanceof BuildFailedError) throw error;
    if (error instanceof LockTimeoutError) {
      await recordBuildFailure(store, paths, job.id, input.now, "worktree_lock_timeout");
    } else if (error instanceof Error && error.name === "BuildEvidenceError") {
      await recordBuildFailure(store, paths, job.id, input.now, "incomplete_evidence");
    } else if (!(error instanceof InvalidJobStateError)) {
      await recordBuildFailure(store, paths, job.id, input.now, "builder_error");
    }
    throw error;
  } finally {
    await lock?.release();
  }
}

export class BuildFailedError extends Error {
  readonly jobId: string;

  constructor(jobId: string, reason: string) {
    super(`build for ${jobId} failed: ${reason}`);
    this.name = "BuildFailedError";
    this.jobId = jobId;
  }
}

function assertBuildStage(job: Job): void {
  if (job.stage !== "build" || job.status !== "active") {
    throw new InvalidJobStateError(job.id, "stage build with status active", job.stage, job.status);
  }
}

async function recordBuildFailure(store: BoardStore, paths: ReturnType<typeof factoryPaths>, jobId: string, now: (() => Date) | undefined, eventName: string): Promise<void> {
  const at = (now ?? (() => new Date()))().toISOString();
  await store.mutate(async (draft) => {
    const current = draft.jobs.find((candidate) => candidate.id === jobId);
    if (!current || current.stage !== "build" || current.status !== "active") return;
    const entry = { at, from: "build" as const, to: "build" as const, actor: "factory", event: `build_failed:${eventName}` };
    await appendJobEvent(paths, jobId, entry);
    current.history.push(entry);
    current.status = "blocked";
    current.updated_at = at;
  });
}

async function runConfiguredValidation(command: { name: string; command: string }, cwd: string): Promise<ValidationResult> {
  const parts = command.command.trim().split(/\s+/);
  const executable = parts.shift();
  if (!executable) return { ...command, outcome: "FAIL", output: "empty command" };
  try {
    const result = await execFileAsync(executable, parts, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return { ...command, outcome: "PASS", output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    return { ...command, outcome: "FAIL", output: `${detail.stdout ?? ""}${detail.stderr ?? detail.message ?? ""}`.trim() };
  }
}

export function renderBuildEvidence(validation: ValidationResult[]): string {
  const rows = validation.map((item) => `- ${item.name}: ${item.outcome} (\`${item.command}\`)`).join("\n");
  return rows || "- No configured validation commands.";
}

async function mergeValidationEvidence(file: string, validation: ValidationResult[]): Promise<void> {
  const markdown = await fs.readFile(file, "utf8");
  const heading = /^##\\s+Validation\\s*$/im;
  const match = heading.exec(markdown);
  const section = `## Validation\\n\\n${renderBuildEvidence(validation)}\\n`;
  if (!match || match.index === undefined) {
    await fs.writeFile(file, `${markdown.trimEnd()}\\n\\n${section}`, "utf8");
    return;
  }
  const nextHeading = /\\n##\\s+/g;
  nextHeading.lastIndex = match.index + match[0].length;
  const next = nextHeading.exec(markdown);
  const end = next?.index ?? markdown.length;
  await fs.writeFile(file, `${markdown.slice(0, match.index)}${section}${markdown.slice(end)}`, "utf8");
}

export type { FactoryPolicy };
