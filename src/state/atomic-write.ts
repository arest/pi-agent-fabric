import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

/**
 * Write a file atomically: write a sibling temp file, flush it, rename it over
 * the target, then flush the parent directory so the rename is durable.
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  const handle = await fs.open(tempPath, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  await fsyncDirectory(dir);
}

/**
 * Flush a directory entry. Not every platform/filesystem supports fsync on a
 * directory, so an unsupported operation is tolerated rather than fatal.
 */
async function fsyncDirectory(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort durability, not a correctness requirement.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
