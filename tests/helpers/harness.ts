import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import factoryExtension from "../../extensions/factory.ts";
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

export function boardPath(cwd: string): string {
  return path.join(cwd, "factory", "board.json");
}

export function jobDirPath(cwd: string, jobId: string): string {
  return path.join(cwd, "factory", "jobs", jobId);
}

export function jobEventsPath(cwd: string, jobId: string): string {
  return path.join(jobDirPath(cwd, jobId), "events.jsonl");
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
}

export async function readJobEvents(cwd: string, jobId: string): Promise<RecordedEvent[]> {
  const raw = await fs.readFile(jobEventsPath(cwd, jobId), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedEvent);
}
