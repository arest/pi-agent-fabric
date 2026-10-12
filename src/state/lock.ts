import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * A minimal cross-process advisory lock built on exclusive file creation.
 *
 * The factory relies on this to serialize board writes across concurrent jobs
 * and separate Pi processes. Contention is reported as a typed error so callers
 * can surface it as a recoverable blocked condition.
 */
export interface LockOptions {
  /** Total time to keep retrying before giving up. */
  timeoutMs?: number;
  /** A lock with no usable owner information older than this is treated as abandoned. */
  staleMs?: number;
  /** Delay between acquisition attempts. */
  pollMs?: number;
}

export interface LockHandle {
  release(): Promise<void>;
}

export class LockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for lock ${lockPath}`);
    this.name = "LockTimeoutError";
    this.lockPath = lockPath;
  }
}

interface LockRecord {
  token?: string;
  pid?: number;
  acquired_at?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockRecord(lockPath: string): Promise<LockRecord> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as LockRecord) : {};
  } catch {
    return {};
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove a lock whose owner is demonstrably gone.
 *
 * A live owner is never reclaimed, however long it holds the lock, so a slow
 * writer cannot lose exclusivity to a second writer. Only when the owner cannot
 * be shown to be alive (dead pid, or no usable owner record at all) does age
 * decide.
 */
async function removeIfStale(lockPath: string, staleMs: number): Promise<void> {
  const record = await readLockRecord(lockPath);
  if (typeof record.pid === "number") {
    if (!processIsAlive(record.pid)) await fs.rm(lockPath, { force: true });
    return;
  }

  try {
    const stats = await fs.stat(lockPath);
    if (Date.now() - stats.mtimeMs > staleMs) {
      await fs.rm(lockPath, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function acquireLock(lockPath: string, options: LockOptions = {}): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    const token = randomUUID();
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }

      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          // Only remove the lock if it is still ours: a lock reclaimed by
          // another process must not be deleted out from under its new owner.
          const current = await readLockRecord(lockPath);
          if (current.token !== token) return;
          await fs.rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeIfStale(lockPath, staleMs);
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
      await delay(pollMs);
    }
  }
}
