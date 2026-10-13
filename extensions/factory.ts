/**
 * Pi Agent Fabric Factory extension.
 *
 * Owns the `/factory` command surface and is the only component that writes
 * durable board state.
 *
 * Implemented today:
 * - `/factory <feature>` seeds a job: an id, a job artifact directory, and an
 *   `active`/`spec` board entry, after validating repository policy.
 * - `/factory spec <job-id>` runs the spec-writer stage: the role's `spec.md`
 *   is scaffolded when absent, validated against the required-section contract,
 *   and only then does the job advance to `build`.
 * - `/factory approve|rework|retry|promote|cancel <job-id>` runs a guarded
 *   operator transition that preserves history and never deletes work.
 *
 * Later tickets add crash recovery and the read-only dashboard.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SpecContractError } from "../src/artifacts/spec.ts";
import type { Job } from "../src/state/board.ts";
import { isJobId } from "../src/state/job-id.ts";
import { CommandNotEligibleError, JobNotFoundError, OperatorRequestError } from "../src/workflow/errors.ts";
import {
  approveJob,
  cancelJob,
  isOperatorCommand,
  promoteJob,
  retryJob,
  reworkJob,
  type OperatorCommand,
  type OperatorCommandResult,
} from "../src/workflow/operator-commands.ts";
import { isPromotionTarget, type PromotionTarget } from "../src/workflow/promotion/gh-adapter.ts";
import { runSpecStage } from "../src/workflow/spec-stage.ts";
import { InvalidFeatureError, startJob } from "../src/workflow/start-job.ts";

const USAGE = "Usage: /factory <feature request>";
const SPEC_USAGE = "Usage: /factory spec <job-id>";

const OPERATOR_USAGE: Record<OperatorCommand, string> = {
  approve: "Usage: /factory approve <job-id> [note]",
  rework: "Usage: /factory rework <job-id> <note>",
  retry: "Usage: /factory retry <job-id> [note]",
  promote: "Usage: /factory promote <job-id> [main|master]",
  cancel: "Usage: /factory cancel <job-id> [note]",
};

/** Operator commands that take only a job id and an optional note. */
type SimpleOperatorCommand = Exclude<OperatorCommand, "promote">;

interface OperatorTransition {
  run(input: { cwd: string; jobId: string; note: string }): Promise<OperatorCommandResult>;
  summarize(job: Job): string;
}

/**
 * One entry per simple command, so the transition and its success message can
 * never drift apart. `promote` is separate: it also takes a target branch.
 */
const OPERATOR_TRANSITIONS: Record<SimpleOperatorCommand, OperatorTransition> = {
  approve: {
    run: approveJob,
    summarize: (job) => `Human approval recorded for factory job ${job.id}; advanced to stage ${job.stage}.`,
  },
  rework: {
    run: reworkJob,
    summarize: (job) =>
      `Opened builder round ${job.round} for factory job ${job.id}; your note is recorded in job history.`,
  },
  retry: {
    run: retryJob,
    summarize: (job) =>
      `Cleared the blocked condition for factory job ${job.id}; it is active at stage ${job.stage} again.`,
  },
  cancel: {
    run: cancelJob,
    summarize: (job) =>
      `Cancelled factory job ${job.id}. History, artifacts, branches, worktrees, and PRs were preserved.`,
  },
};

/**
 * Operator subcommands owned by later tickets. Until they are implemented they
 * must report unavailability rather than being treated as feature text.
 */
const RESERVED_SUBCOMMANDS = new Set(["next"]);

function describeError(error: unknown): string {
  if (error instanceof InvalidFeatureError) return USAGE;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Run the spec-writer stage for one job and advance it to `build` when complete. */
async function runSpecCommand(jobId: string, ctx: ExtensionCommandContext): Promise<void> {
  if (jobId.length === 0) {
    ctx.ui.notify(SPEC_USAGE, "warning");
    return;
  }

  try {
    const { job, specFile } = await runSpecStage({ cwd: ctx.cwd, jobId });
    const specPath = path.relative(ctx.cwd, specFile) || specFile;
    ctx.ui.notify(
      `Spec for factory job ${job.id} is complete; advanced to stage ${job.stage}. Spec: ${specPath}`,
      "info",
    );
  } catch (error) {
    if (error instanceof SpecContractError) {
      ctx.ui.notify(
        `Spec for factory job ${jobId} is incomplete. Fill the missing sections in spec.md, then run /factory spec ${jobId} again. Missing: ${error.missing.join(", ")}.`,
        "error",
      );
      return;
    }
    ctx.ui.notify(`Factory could not advance spec for ${jobId}: ${describeError(error)}`, "error");
  }
}

/** Run one guarded operator transition and report an explicit outcome. */
async function runOperatorCommand(command: OperatorCommand, args: string[], ctx: ExtensionCommandContext): Promise<void> {
  const jobId = args[0] ?? "";
  if (!isJobId(jobId)) {
    const suffix = jobId.length > 0 ? ` (${jobId} is not a job id)` : "";
    ctx.ui.notify(`${OPERATOR_USAGE[command]}${suffix}`, "warning");
    return;
  }

  const rest = args.slice(1);
  try {
    if (command === "promote") {
      let target: PromotionTarget = "main";
      if (isPromotionTarget(rest[0] ?? "")) target = rest.shift() as PromotionTarget;
      const { job, promotion } = await promoteJob({ cwd: ctx.cwd, jobId, target, note: rest.join(" ") });
      ctx.ui.notify(
        `Prepared promotion PR for factory job ${job.id} to ${target}: ${promotion.url}. A human must merge it; the factory never merges or changes branch protection.`,
        "info",
      );
      return;
    }

    const note = rest.join(" ");
    const transition = OPERATOR_TRANSITIONS[command];
    const result = await transition.run({ cwd: ctx.cwd, jobId, note });
    ctx.ui.notify(transition.summarize(result.job), "info");
  } catch (error) {
    if (error instanceof CommandNotEligibleError || error instanceof JobNotFoundError) {
      ctx.ui.notify(error.message, "error");
      return;
    }
    if (error instanceof OperatorRequestError) {
      ctx.ui.notify(error.message, "warning");
      return;
    }
    ctx.ui.notify(`Factory could not ${command} ${jobId}: ${describeError(error)}`, "error");
  }
}

export default function factoryExtension(pi: ExtensionAPI): void {
  pi.registerCommand("factory", {
    description: "Start a factory job from a feature request, or advance its spec stage",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const request = args.trim();
      if (request.length === 0) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }

      const [verb = "", ...rest] = request.split(/\s+/);
      const subcommand = verb.toLowerCase();

      if (subcommand === "spec") {
        // `spec` is the operator subcommand only with exactly one argument that
        // is a job id. Extra words make it an ordinary feature request, and a
        // lone non-id argument is a likely typo, so warn instead of starting a
        // job the operator did not ask for.
        if (rest.length === 0) {
          ctx.ui.notify(SPEC_USAGE, "warning");
          return;
        }
        if (rest.length === 1) {
          const jobId = rest[0] ?? "";
          if (!isJobId(jobId)) {
            ctx.ui.notify(`${SPEC_USAGE} (${jobId} is not a job id)`, "warning");
            return;
          }
          await runSpecCommand(jobId, ctx);
          return;
        }
      }

      if (isOperatorCommand(subcommand)) {
        await runOperatorCommand(subcommand, rest, ctx);
        return;
      }

      if (RESERVED_SUBCOMMANDS.has(subcommand)) {
        ctx.ui.notify(
          `/factory ${verb} is not available yet; only /factory <feature request>, /factory spec <job-id>, and the operator commands (approve, rework, retry, promote, cancel) are implemented.`,
          "warning",
        );
        return;
      }

      try {
        const { job, boardFile } = await startJob({ cwd: ctx.cwd, feature: request });
        const boardPath = path.relative(ctx.cwd, boardFile) || boardFile;
        ctx.ui.notify(
          `Factory job ${job.id} started: stage ${job.stage}, status ${job.status}, branch ${job.branch}. Board: ${boardPath}. Next: write factory/jobs/${job.id}/spec.md (run "/factory spec ${job.id}" to scaffold it), then "/factory spec ${job.id}" to advance to build.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Factory could not start job: ${describeError(error)}`, "error");
      }
    },
  });
}
