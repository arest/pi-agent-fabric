/**
 * Shared `gh`/process helpers for the GitHub-backed adapters.
 *
 * Publication and promotion both shell out to `gh`, parse its JSON, and wrap
 * failures in their own typed error, so the mechanics live here and each
 * adapter supplies the error class and the command-specific logic.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "../security/sanitize.ts";

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
  function policyViolation(reason: string): never {
    throw makeError(`policy violation: ${reason}`);
  }

  function renderCommand(executable: string, args: string[]): string {
    const safeArgs = args.map((arg) => redactSecrets(arg));
    return `${executable} ${safeArgs.join(" ")}`.trim();
  }

  function assertAllowed(executable: string, args: string[]): void {
    const command = executable.toLowerCase();
    if (command === "git") {
      const [verb = ""] = args;
      if (verb === "push") {
        if (args.includes("--force") || args.includes("-f") || args.includes("--force-with-lease")) {
          policyViolation("denied git action `push --force`");
        }
        if (args.includes("--delete") || args.some((arg) => arg.startsWith(":"))) {
          policyViolation("denied git action `push --delete` (remote branch deletion)");
        }
      }
      if (verb === "reset" && args.includes("--hard")) {
        policyViolation("denied git action `reset --hard`");
      }
      if (verb === "clean") {
        policyViolation("denied git action `clean`");
      }
      return;
    }

    if (command === "gh") {
      const [scope = "", action = ""] = args;
      if (scope === "pr" && action === "merge") {
        policyViolation("denied GitHub action `gh pr merge`");
      }
      if (scope === "api") {
        const mutatingMethodIndex = args.findIndex((arg) => arg === "-X" || arg === "--method");
        const method = (mutatingMethodIndex >= 0 ? args[mutatingMethodIndex + 1] : "GET")?.toUpperCase() ?? "GET";
        const touchesProtection = args.some((arg) => /\/protection\b/i.test(arg) || /required_status_checks/i.test(arg));
        if (touchesProtection && method !== "GET") {
          policyViolation("denied GitHub action mutating branch protection or required checks");
        }
      }
    }
  }

  async function run(cwd: string, executable: string, args: string[]): Promise<string> {
    assertAllowed(executable, args);
    try {
      const result = await execFileAsync(executable, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
      return `${result.stdout}${result.stderr}`.trim();
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string; message?: string };
      const reason = redactSecrets(`${detail.stdout ?? ""}${detail.stderr ?? detail.message ?? ""}`.trim());
      const command = renderCommand(executable, args);
      throw makeError(`${command} failed${reason.length > 0 ? `: ${reason}` : ""}`);
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
      throw makeError(`gh command did not return JSON: ${renderCommand("gh", args)}`);
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
