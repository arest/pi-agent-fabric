/**
 * Shared `gh`/process helpers for the GitHub-backed adapters.
 *
 * Publication and promotion both shell out to `gh`, parse its JSON, and wrap
 * failures in their own typed error, so the mechanics live here and each
 * adapter supplies the error class and the command-specific logic.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Builds the adapter-specific error for a failed call or unexpected output. */
export type GhErrorFactory = (message: string) => Error;

export interface GhToolkit {
  /** Run any executable and return its combined, trimmed output. */
  run(cwd: string, executable: string, args: string[]): Promise<string>;
  gh(cwd: string, args: string[]): Promise<string>;
  ghJson<T>(cwd: string, args: string[]): Promise<T>;
  asString(value: unknown, context: string): string;
  asNumber(value: unknown, context: string): number;
}

export function createGhToolkit(makeError: GhErrorFactory): GhToolkit {
  async function run(cwd: string, executable: string, args: string[]): Promise<string> {
    try {
      const result = await execFileAsync(executable, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
      return `${result.stdout}${result.stderr}`.trim();
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string; message?: string };
      const reason = `${detail.stdout ?? ""}${detail.stderr ?? detail.message ?? ""}`.trim();
      throw makeError(`${executable} ${args.join(" ")} failed${reason.length > 0 ? `: ${reason}` : ""}`);
    }
  }

  async function gh(cwd: string, args: string[]): Promise<string> {
    return run(cwd, "gh", args);
  }

  async function ghJson<T>(cwd: string, args: string[]): Promise<T> {
    const output = await gh(cwd, args);
    try {
      return JSON.parse(output) as T;
    } catch {
      throw makeError(`gh command did not return JSON: gh ${args.join(" ")}`);
    }
  }

  function asString(value: unknown, context: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw makeError(`${context} is missing or not text`);
    }
    return value;
  }

  function asNumber(value: unknown, context: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw makeError(`${context} is missing or invalid`);
    }
    return value;
  }

  return { run, gh, ghJson, asString, asNumber };
}
