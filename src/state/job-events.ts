import fs from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write.ts";
import { jobEventsFile, type FactoryPaths } from "./paths.ts";

/**
 * One durable line in `factory/jobs/<job-id>/events.jsonl`.
 *
 * The event log is append-only job history owned by the extension. It mirrors
 * the board `history` entries with an explicit `job_id`, so a job's story can
 * be read without loading the whole board.
 */
export interface JobEvent {
  at: string;
  job_id: string;
  event: string;
  from: string | null;
  to: string;
  actor: string;
}

/** An event as recorded, before the writer attaches the owning job id. */
export type JobEventInput = Omit<JobEvent, "job_id">;

/** Raised when an event log cannot be read as the documented JSONL shape. */
export class JobEventLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobEventLogError";
  }
}

/** Read every event for a job. A missing log reads as an empty history. */
export async function readJobEvents(paths: FactoryPaths, jobId: string): Promise<JobEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(jobEventsFile(paths, jobId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new JobEventLogError(`event ${index} for job ${jobId} is not valid JSON`);
      }
      if (typeof value !== "object" || value === null) {
        throw new JobEventLogError(`event ${index} for job ${jobId} is not an object`);
      }

      const record = value as Record<string, unknown>;
      const { at, job_id, event, from, to, actor } = record;
      if (
        typeof at !== "string" ||
        typeof job_id !== "string" ||
        typeof event !== "string" ||
        typeof to !== "string" ||
        typeof actor !== "string" ||
        (from !== null && typeof from !== "string")
      ) {
        throw new JobEventLogError(`event ${index} for job ${jobId} is missing required fields`);
      }
      return { at, job_id, event, from, to, actor };
    });
}

/**
 * Append one event under the caller's board lock. The whole log is rewritten
 * atomically so readers never observe a partial line; callers must already hold
 * the board lock, which is the only serialization point for job artifacts.
 */
export async function appendJobEvent(
  paths: FactoryPaths,
  jobId: string,
  event: JobEventInput,
): Promise<void> {
  const file = jobEventsFile(paths, jobId);
  const record: JobEvent = { ...event, job_id: jobId };

  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  await writeFileAtomic(file, `${prefix}${JSON.stringify(record)}\n`);
}
