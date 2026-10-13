import fs from "node:fs/promises";
import { assertReviewComplete, isBlockingReport, type ReviewSeverity, type ReviewVerdict } from "../artifacts/review.ts";
import { readJobEvents } from "../state/job-events.ts";
import {
  jobBuildFile,
  jobReviewDir,
  jobReviewPlan,
  jobReviewReport,
  jobRoundBuildFile,
  jobRoundReviewPlan,
  type FactoryPaths,
} from "../state/paths.ts";
import { ReworkContextError } from "./errors.ts";

/** A validated report retained from a round that has already closed. */
export interface PriorRoundReport {
  role: string;
  round: number;
  verdict: ReviewVerdict;
  severity: ReviewSeverity;
  /** Absolute path of the retained report, for the resumed builder to read. */
  file: string;
}

/** Everything the resumed builder needs about the round it must answer. */
export interface ReworkContext {
  /** Round whose blocking findings triggered this rework. */
  fromRound: number;
  /** Reports retained from every earlier round, oldest first. */
  priorReports: PriorRoundReport[];
  /** The subset of `priorReports` that blocked the previous round. */
  blocking: PriorRoundReport[];
  /**
   * Operator notes from earlier `/factory rework` requests, oldest first. An
   * automatic round has none; a human-driven round carries the guidance that
   * opened it so the resumed builder can act on it.
   */
  humanNotes: string[];
}

interface RetainedPlan {
  selected: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetainedPlan(value: unknown): RetainedPlan {
  if (!isRecord(value) || !Array.isArray(value.selected) || !value.selected.every((role) => typeof role === "string" && role.length > 0)) {
    throw new Error("retained review plan has no selected reviewer list");
  }
  return { selected: value.selected };
}

/**
 * Retain the round's reviewer selection and build evidence inside the round
 * directory before the next round overwrites the live files. Review reports are
 * already written per round and are never touched.
 */
export async function retainRoundEvidence(paths: FactoryPaths, jobId: string, round: number): Promise<void> {
  await fs.mkdir(jobReviewDir(paths, jobId, round), { recursive: true });
  await copyIfPresent(jobBuildFile(paths, jobId), jobRoundBuildFile(paths, jobId, round));
  await copyIfPresent(jobReviewPlan(paths, jobId), jobRoundReviewPlan(paths, jobId, round));
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  try {
    await fs.copyFile(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Reconstruct the retained evidence for every round before `round`.
 *
 * This is deliberately strict. A missing or malformed retained report means the
 * factory cannot know what blocked the previous round, so resuming the builder
 * would silently drop findings. The caller escalates to a human instead.
 */
export async function readReworkContext(paths: FactoryPaths, jobId: string, round: number): Promise<ReworkContext | null> {
  if (round <= 1) return null;
  const priorReports: PriorRoundReport[] = [];

  for (let priorRound = 1; priorRound < round; priorRound += 1) {
    const planFile = jobRoundReviewPlan(paths, jobId, priorRound);
    let plan: RetainedPlan;
    try {
      plan = parseRetainedPlan(JSON.parse(await fs.readFile(planFile, "utf8")));
    } catch (error) {
      throw new ReworkContextError(jobId, round, `round ${priorRound} has no readable review plan at ${planFile} (${describe(error)})`);
    }

    for (const role of plan.selected) {
      const file = jobReviewReport(paths, jobId, priorRound, role);
      let parsed;
      try {
        parsed = assertReviewComplete(await fs.readFile(file, "utf8"), file);
      } catch (error) {
        throw new ReworkContextError(jobId, round, `round ${priorRound} report for ${role} is missing or invalid at ${file} (${describe(error)})`);
      }
      priorReports.push({ role, round: priorRound, verdict: parsed.verdict, severity: parsed.severity, file });
    }
  }

  return {
    fromRound: round - 1,
    priorReports,
    blocking: priorReports.filter((report) => report.round === round - 1 && isBlockingReport(report)),
    humanNotes: await readHumanNotes(paths, jobId, round),
  };
}

/**
 * Operator guidance attached to earlier human rework rounds, oldest first. A
 * missing event log reads as no human guidance.
 */
async function readHumanNotes(paths: FactoryPaths, jobId: string, round: number): Promise<string[]> {
  const events = await readJobEvents(paths, jobId);
  return events
    .filter((event) => event.event === "human_rework" && typeof event.note === "string" && event.note.length > 0)
    .filter((event) => event.round === undefined || event.round < round)
    .map((event) => event.note as string);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
