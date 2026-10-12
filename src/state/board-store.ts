import fs from "node:fs/promises";
import { BoardIntegrityError, createEmptyBoard, parseBoard, type Board } from "./board.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { acquireLock } from "./lock.ts";
import { factoryPaths, type FactoryPaths } from "./paths.ts";

/** Thrown when a caller's expected board version no longer matches disk state. */
export class StaleBoardError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(`board has version ${actualVersion}, expected ${expectedVersion}`);
    this.name = "StaleBoardError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export interface MutateOptions {
  /** Reject the write if the on-disk board does not have this exact version. */
  expectedVersion?: number;
}

export interface MutateResult<T> {
  board: Board;
  result: T;
}

/**
 * The extension-owned writer for `factory/board.json`.
 *
 * Every mutation runs under a cross-process lock, applies to a private copy,
 * bumps the version, and swaps the file in atomically so readers never observe
 * a partial board and concurrent writers never interleave. History and prior
 * job artifacts are preserved; nothing is deleted.
 */
export class BoardStore {
  readonly paths: FactoryPaths;

  constructor(cwd: string) {
    this.paths = factoryPaths(cwd);
  }

  /** Read the board without locking. Missing board files read as an empty board. */
  async read(): Promise<Board> {
    let raw: string;
    try {
      raw = await fs.readFile(this.paths.boardFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyBoard();
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BoardIntegrityError(`board at ${this.paths.boardFile} is not valid JSON`);
    }
    return parseBoard(value);
  }

  /**
   * Apply `mutator` to the current board and persist the result atomically.
   * The mutator may perform file I/O (for example creating job artifacts)
   * before the board is written, so that artifacts exist first.
   */
  async mutate<T>(
    mutator: (board: Board) => T | Promise<T>,
    options: MutateOptions = {},
  ): Promise<MutateResult<T>> {
    const lock = await acquireLock(this.paths.boardLockFile);
    try {
      const current = await this.read();
      if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
        throw new StaleBoardError(options.expectedVersion, current.version);
      }

      const draft = structuredClone(current);
      const result = await mutator(draft);
      draft.version = current.version + 1;
      await writeFileAtomic(this.paths.boardFile, `${JSON.stringify(draft, null, 2)}\n`);
      return { board: draft, result };
    } finally {
      await lock.release();
    }
  }
}
