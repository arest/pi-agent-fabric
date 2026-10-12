import fs from "node:fs/promises";
import path from "node:path";

export const POLICY_SCHEMA_VERSION = 1;

export interface PolicySnapshot {
  v: 1;
  source: "default" | "repo";
  mode: "develop";
  target: "develop";
}

export interface FactoryPolicy {
  schema_version: 1;
  target_mode: "develop";
  target: "develop";
  human_merge_required: true;
  reviewers: {
    available: string[];
    required: string[];
    selection: "orchestrator";
  };
  limits: {
    max_review_rounds: number;
    max_jobs_per_batch: number;
  };
  github: {
    adapter: "gh";
    auto_merge: false;
  };
  repository: {
    test_commands: Array<{ name: string; command: string }>;
    required_files: string[];
  };
  source: "default" | "repo";
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const DEFAULT_POLICY_INPUT = {
  schema_version: 1,
  target_mode: "develop",
  reviewers: { available: [], required: [], selection: "orchestrator" },
  limits: { max_review_rounds: 2, max_jobs_per_batch: 20 },
  github: { adapter: "gh", auto_merge: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PolicyError(`${context} contains unsupported key ${key}`);
  }
}

function requiredRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PolicyError(`${context} must be an object`);
  return value;
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new PolicyError(`${context} must be a non-empty-string array`);
  }
  return [...value];
}

function safeRelativePath(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new PolicyError(`${context} must be a safe relative path`);
  }
  return value;
}

function parsePolicy(raw: unknown, source: "default" | "repo"): FactoryPolicy {
  const value = requiredRecord(raw, "policy");
  rejectUnknown(value, ["schema_version", "target_mode", "repository", "git", "reviewers", "limits", "github", "promotion", "human_merge_required"], "policy");
  if (value.schema_version !== POLICY_SCHEMA_VERSION) {
    throw new PolicyError(`unsupported policy schema_version ${String(value.schema_version)} (expected ${POLICY_SCHEMA_VERSION})`);
  }

  const git = value.git === undefined ? {} : requiredRecord(value.git, "policy.git");
  rejectUnknown(git, ["default_target", "target_mode", "human_merge_required", "aggregator_enabled"], "policy.git");
  const targetMode = value.target_mode ?? git.target_mode ?? "develop";
  if (targetMode !== "develop") throw new PolicyError(`unsupported target_mode ${String(targetMode)}; only develop is safe`);
  const target = git.default_target ?? "develop";
  if (target !== "develop") throw new PolicyError(`unsupported default target ${String(target)}; only develop is safe`);
  if (git.aggregator_enabled !== undefined && git.aggregator_enabled !== false) {
    throw new PolicyError("aggregator mode is not supported by the core factory");
  }
  const humanMergeRequired = value.human_merge_required ?? git.human_merge_required ?? true;
  if (humanMergeRequired !== true) throw new PolicyError("human_merge_required must remain true");

  const repositoryValue = value.repository === undefined ? {} : requiredRecord(value.repository, "policy.repository");
  rejectUnknown(repositoryValue, ["test_commands", "required_files"], "policy.repository");
  const testCommandsRaw = repositoryValue.test_commands ?? [];
  if (!Array.isArray(testCommandsRaw)) throw new PolicyError("policy.repository.test_commands must be an array");
  const testCommands = testCommandsRaw.map((item, index) => {
    const command = requiredRecord(item, `policy.repository.test_commands[${index}]`);
    rejectUnknown(command, ["name", "command"], `policy.repository.test_commands[${index}]`);
    if (typeof command.name !== "string" || command.name.length === 0 || typeof command.command !== "string" || command.command.length === 0) {
      throw new PolicyError(`policy.repository.test_commands[${index}] requires name and command`);
    }
    // Commands are data for a later named-task adapter, not shell snippets.
    // Reject shell control syntax now so policy cannot become an injection
    // channel when a future workflow executes a configured task.
    if (/[\0\r\n;&|`$><()]/.test(command.command)) {
      throw new PolicyError(`policy.repository.test_commands[${index}].command contains unsafe shell syntax`);
    }
    return { name: command.name, command: command.command };
  });
  const requiredFilesRaw = repositoryValue.required_files ?? [];
  if (!Array.isArray(requiredFilesRaw)) throw new PolicyError("policy.repository.required_files must be an array");
  const requiredFiles = requiredFilesRaw.map((item, index) => safeRelativePath(item, `policy.repository.required_files[${index}]`));

  const reviewersValue = value.reviewers === undefined ? DEFAULT_POLICY_INPUT.reviewers : requiredRecord(value.reviewers, "policy.reviewers");
  rejectUnknown(reviewersValue, ["available", "required", "selection"], "policy.reviewers");
  const available = stringArray(reviewersValue.available ?? [], "policy.reviewers.available");
  const required = stringArray(reviewersValue.required ?? [], "policy.reviewers.required");
  if (!required.every((role) => available.includes(role))) throw new PolicyError("policy.reviewers.required must be available");
  if ((reviewersValue.selection ?? "orchestrator") !== "orchestrator") throw new PolicyError("policy.reviewers.selection must be orchestrator");

  const limitsValue = value.limits === undefined ? DEFAULT_POLICY_INPUT.limits : requiredRecord(value.limits, "policy.limits");
  rejectUnknown(limitsValue, ["max_review_rounds", "max_jobs_per_batch"], "policy.limits");
  const maxReviewRounds = limitsValue.max_review_rounds ?? 2;
  const maxJobsPerBatch = limitsValue.max_jobs_per_batch ?? 20;
  if (typeof maxReviewRounds !== "number" || !Number.isInteger(maxReviewRounds) || maxReviewRounds < 1 || maxReviewRounds > 100) throw new PolicyError("policy.limits.max_review_rounds must be an integer from 1 to 100");
  if (typeof maxJobsPerBatch !== "number" || !Number.isInteger(maxJobsPerBatch) || maxJobsPerBatch < 1 || maxJobsPerBatch > 1000) throw new PolicyError("policy.limits.max_jobs_per_batch must be an integer from 1 to 1000");

  const githubValue = value.github === undefined ? DEFAULT_POLICY_INPUT.github : requiredRecord(value.github, "policy.github");
  rejectUnknown(githubValue, ["adapter", "auto_merge"], "policy.github");
  if ((githubValue.adapter ?? "gh") !== "gh") throw new PolicyError("only the gh GitHub adapter is supported");
  if ((githubValue.auto_merge ?? false) !== false) throw new PolicyError("auto_merge must remain false");

  const promotion = value.promotion === undefined ? {} : requiredRecord(value.promotion, "policy.promotion");
  rejectUnknown(promotion, ["develop", "main", "master"], "policy.promotion");
  for (const branch of ["develop", "main", "master"]) {
    if (promotion[branch] !== undefined) {
      const entry = requiredRecord(promotion[branch], `policy.promotion.${branch}`);
      rejectUnknown(entry, ["human_merge_required"], `policy.promotion.${branch}`);
      if (entry.human_merge_required !== true) throw new PolicyError(`policy.promotion.${branch}.human_merge_required must remain true`);
    }
  }

  return {
    schema_version: 1,
    target_mode: "develop",
    target: "develop",
    human_merge_required: true,
    reviewers: { available, required, selection: "orchestrator" },
    limits: { max_review_rounds: maxReviewRounds, max_jobs_per_batch: maxJobsPerBatch },
    github: { adapter: "gh", auto_merge: false },
    repository: { test_commands: testCommands, required_files: requiredFiles },
    source,
  };
}

export function policySnapshot(policy: FactoryPolicy): PolicySnapshot {
  return { v: 1, source: policy.source, mode: "develop", target: "develop" };
}

export async function loadPolicy(cwd: string): Promise<FactoryPolicy> {
  const policyFile = path.join(path.resolve(cwd), ".pi", "factory.json");
  let raw: string;
  try {
    raw = await fs.readFile(policyFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parsePolicy(DEFAULT_POLICY_INPUT, "default");
    throw new PolicyError(`could not read policy at ${policyFile}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PolicyError(`policy at ${policyFile} is not valid JSON`);
  }
  return parsePolicy(value, "repo");
}
