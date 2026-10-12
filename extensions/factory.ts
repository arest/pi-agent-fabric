/**
 * Pi Agent Fabric Factory extension.
 *
 * Owns the `/factory` command surface and is the only component that writes
 * durable board state. The first command, `/factory <feature>`, seeds a new
 * job: an id, a job artifact directory, and an `active`/`spec` board entry.
 *
 * Later tickets add the policy gate, spec-writer, builder, reviewers, approver,
 * GitHub publication, operator commands, recovery, and the dashboard.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { InvalidFeatureError, startJob } from "../src/workflow/start-job.ts";

const USAGE = "Usage: /factory <feature request>";

/**
 * Operator subcommands owned by later tickets. Until they are implemented they
 * must report unavailability rather than being treated as feature text.
 */
const RESERVED_SUBCOMMANDS = new Set(["next", "approve", "rework", "retry", "promote", "cancel"]);

function describeError(error: unknown): string {
  if (error instanceof InvalidFeatureError) return USAGE;
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function factoryExtension(pi: ExtensionAPI): void {
  pi.registerCommand("factory", {
    description: "Start a factory job from a feature request",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const feature = args.trim();
      if (feature.length === 0) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }

      const [verb] = feature.split(/\s+/, 1);
      if (RESERVED_SUBCOMMANDS.has(verb.toLowerCase())) {
        ctx.ui.notify(
          `/factory ${verb} is not available yet; only /factory <feature request> is implemented.`,
          "warning",
        );
        return;
      }

      try {
        const { job, boardFile } = await startJob({ cwd: ctx.cwd, feature });
        const boardPath = path.relative(ctx.cwd, boardFile) || boardFile;
        ctx.ui.notify(
          `Factory job ${job.id} started: stage ${job.stage}, status ${job.status}, branch ${job.branch}. Board: ${boardPath}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Factory could not start job: ${describeError(error)}`, "error");
      }
    },
  });
}
