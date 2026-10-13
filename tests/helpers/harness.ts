import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import factoryExtension from "../../extensions/factory.ts";
import type { Builder, WorktreeProvider } from "../../src/workflow/build-stage.ts";
import type { Reviewer } from "../../src/workflow/review-stage.ts";
import { parseBoard, type Board } from "../../src/state/board.ts";

export interface CapturedNotification {
  message: string;
  type?: "info" | "warning" | "error";
}

export interface Harness {
  readonly commands: Map<string, RegisteredCommand>;
  readonly notifications: CapturedNotification[];
  run(command: string, args: string): Promise<void>;
}

/**
 * Load the extension against a fake Pi API and expose the registered commands.
 * This is the orchestration boundary: tests drive `/factory` exactly as Pi does
 * and assert on durable artifacts rather than private structure.
 */
export function createHarness(cwd: string): Harness {
  const commands = new Map<string, RegisteredCommand>();
  const notifications: CapturedNotification[] = [];

  const pi = {
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
      commands.set(name, {
        name,
        sourceInfo: { path: "tests/helpers/harness.ts", source: "test", scope: "temporary", origin: "top-level" },
        ...options,
      });
    },
  } as unknown as ExtensionAPI;

  factoryExtension(pi);

  const ctx = {
    cwd,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error"): void {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionCommandContext;

  return {
    commands,
    notifications,
    async run(command: string, args: string): Promise<void> {
      const registered = commands.get(command);
      if (!registered) throw new Error(`command /${command} was not registered`);
      await registered.handler(args, ctx);
    },
  };
}

export async function makeTempRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "factory-test-"));
}

export async function removeTempRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Shared stage-role stubs and seeds for workflow tests.
 *
 * A stub role writes only its own artifact, exactly as the real roles must;
 * the fixtures below satisfy the artifact contracts so a stage run advances.
 */

/** Worktree provider that puts the "worktree" at the repo root itself. */
export const stubWorktreeProvider = (cwd: string): WorktreeProvider => ({
  prepare: async () => ({ path: cwd, lockPath: path.join(cwd, "builder.lock") }),
});

/** A builder that writes complete build evidence. */
export const evidenceBuilder: Builder = async ({ buildFile }) =>
  fs.writeFile(buildFile, "## Changed files\n\n- src/example.ts\n\n## Validation\n\n- PASS\n\n## Remaining risks\n\nNone\n");

/** A reviewer that writes a complete PASS report. */
export const passReviewer: Reviewer = async ({ reportFile, role }) =>
  fs.writeFile(
    reportFile,
    `# ${role}\n\nVERDICT: PASS\nSEVERITY: NON-BLOCKING\n\n## Summary\n\nLooks good.\n\n## Findings\n\nNone.\n\n## Evidence\n\nInspected diff.\n\n## Recommendations\n\nNone.\n`,
  );

/** A reviewer that writes a complete blocking CHANGES report. */
export const blockingReviewer: Reviewer = async ({ reportFile, role }) =>
  fs.writeFile(
    reportFile,
    `# ${role}\n\nVERDICT: CHANGES\nSEVERITY: BLOCKING\n\n## Summary\n\nFix it.\n\n## Findings\n\nBug.\n\n## Evidence\n\nDiff.\n\n## Recommendations\n\nFix.\n`,
  );

/** An approver decision artifact with a complete APPROVE decision. */
export const approveDecision =
  "DECISION: APPROVE\n\n## Spec checks\n\nAcceptance criteria are covered by tests.\n\n## Implementation evidence\n\nDiff and build evidence are in scope.\n\n## Policy context\n\nTarget remains develop with human merge required.\n";

/** An approver decision artifact with a complete ESCALATE decision. */
export const escalateDecision =
  "DECISION: ESCALATE\n\n## Spec checks\n\nScope and acceptance criteria conflict.\n\n## Implementation evidence\n\nDiff does not prove safe rollout.\n\n## Policy context\n\nRisk requires human decision.\n";

/** Write a factory policy selecting only the stub reviewer roles. */
export async function configureFactory(cwd: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".pi", "factory.json"),
    JSON.stringify({ schema_version: 1, reviewers: { available: ["code"], required: ["code"] }, ...overrides }),
  );
}

export function boardPath(cwd: string): string {
  return path.join(cwd, "factory", "board.json");
}

export function jobDirPath(cwd: string, jobId: string): string {
  return path.join(cwd, "factory", "jobs", jobId);
}

export function jobEventsPath(cwd: string, jobId: string): string {
  return path.join(jobDirPath(cwd, jobId), "events.jsonl");
}

/** Path of the spec-writer's artifact for a job. */
export function jobSpecPath(cwd: string, jobId: string): string {
  return path.join(jobDirPath(cwd, jobId), "spec.md");
}

/** A spec.md body that satisfies every required section of the contract. */
export function completeSpecMarkdown(overrides: Record<string, string> = {}): string {
  const sections: Record<string, string> = {
    Problem: "Rate limiting is missing, so one client can exhaust the API.",
    Scope: "Add per-key limits to the public API. Non-goal: billing integration.",
    "Acceptance criteria": "- [ ] Requests above the limit return 429.",
    "Affected areas": "src/http/middleware",
    "Validation commands": "npm test",
    "Risks and assumptions": "Assumes the gateway forwards client keys.",
    ...overrides,
  };
  return `${Object.entries(sections)
    .map(([title, body]) => `## ${title}\n\n${body}\n`)
    .join("\n")}`;
}

/** Read and validate `factory/board.json` through the production parser. */
export async function readBoard(cwd: string): Promise<Board> {
  return parseBoard(JSON.parse(await fs.readFile(boardPath(cwd), "utf8")));
}

export interface RecordedEvent {
  at: string;
  job_id: string;
  event: string;
  from: string | null;
  to: string;
  actor: string;
  round?: number;
  note?: string;
}

export async function readJobEvents(cwd: string, jobId: string): Promise<RecordedEvent[]> {
  const raw = await fs.readFile(jobEventsPath(cwd, jobId), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedEvent);
}
