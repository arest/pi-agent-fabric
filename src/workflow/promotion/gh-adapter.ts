import type { FactoryPolicy } from "../../config/policy.ts";
import type { Job, PullRequest } from "../../state/board.ts";
import { createGhToolkit } from "../gh.ts";

const gh = createGhToolkit((message) => new PromotionAdapterError(message));

/**
 * Branches a promotion PR may target. Promotion is the only action that moves
 * work toward a protected branch, and it stays a human-merged PR: the adapter
 * never merges, force-pushes, or changes branch protection.
 */
export const PROMOTION_TARGETS = ["main", "master"] as const;
export type PromotionTarget = (typeof PROMOTION_TARGETS)[number];

export function isPromotionTarget(value: string): value is PromotionTarget {
  return (PROMOTION_TARGETS as readonly string[]).includes(value);
}

export interface PromotionAdapterInput {
  cwd: string;
  job: Job;
  policy: FactoryPolicy;
  /** Protected branch the promotion PR targets. */
  target: PromotionTarget;
}

/** The promotion seam. The only operation is preparing a PR for a human. */
export interface PromotionAdapter {
  preparePromotion(input: PromotionAdapterInput): Promise<PullRequest>;
}

export class PromotionAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionAdapterError";
  }
}

export function createGhPromotionAdapter(): PromotionAdapter {
  return { preparePromotion: prepareGhPromotion };
}

/**
 * Prepare (or reuse) the open promotion PR from the job's integration branch to
 * the protected target branch. Idempotent: a second call reuses the open PR
 * rather than opening a duplicate. Never merges.
 */
async function prepareGhPromotion(input: PromotionAdapterInput): Promise<PullRequest> {
  // Fail closed on policy drift: a promotion is only ever a human-merged PR.
  if (input.policy.human_merge_required !== true || input.policy.github.auto_merge !== false) {
    throw new PromotionAdapterError("promotion requires human_merge_required and github.auto_merge disabled");
  }

  await gh.gh(input.cwd, ["auth", "status"]);

  const head = input.job.target;
  const base = input.target;
  // Scoped to this job's integration branch, so an unrelated open PR can never
  // be adopted as this job's promotion.
  const existing = await gh.ghJson<Array<{ number?: unknown }>>(input.cwd, [
    "pr",
    "list",
    "--head",
    head,
    "--base",
    base,
    "--state",
    "open",
    "--json",
    "number",
  ]);

  let prNumber: number | null = null;
  if (existing.length > 0) {
    prNumber = gh.asNumber(existing[0]?.number, "open promotion PR number");
  } else {
    const body = [
      "Human-controlled promotion prepared by the Pi Agent Fabric Factory.",
      "",
      `- From: ${head}`,
      `- To: ${base}`,
      "- Merge policy: human merge required",
      "- Auto-merge: disabled",
      "",
      `Factory job: ${input.job.id}`,
    ].join("\n");
    await gh.gh(input.cwd, [
      "pr",
      "create",
      "--base",
      base,
      "--head",
      head,
      "--title",
      `[factory] promote ${head} to ${base}`,
      "--body",
      body,
    ]);
  }

  const view = await gh.ghJson<{ url?: unknown; state?: unknown }>(input.cwd, [
    "pr",
    "view",
    prNumber === null ? head : String(prNumber),
    "--json",
    "url,state",
  ]);

  return {
    url: gh.asString(view.url, "promotion pull request url"),
    state: gh.asString(view.state, "promotion pull request state"),
    merge_state: "WAITING_FOR_HUMAN",
  };
}
