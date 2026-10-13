import type { FactoryPolicy } from "../../config/policy.ts";
import type { Job, PullRequest } from "../../state/board.ts";
import { createGhToolkit } from "../gh.ts";

const gh = createGhToolkit((message) => new PublicationAdapterError(message));

export interface PublicationAdapterInput {
  cwd: string;
  job: Job;
  policy: FactoryPolicy;
}

export interface PublicationAdapter {
  preflight(input: PublicationAdapterInput): Promise<void>;
  ensurePullRequest(input: PublicationAdapterInput): Promise<PullRequest>;
}

export class PublicationAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationAdapterError";
  }
}

export function createGhPublicationAdapter(): PublicationAdapter {
  return {
    preflight: runGhPreflight,
    ensurePullRequest: ensureGhPullRequest,
  };
}

async function runGhPreflight(input: PublicationAdapterInput): Promise<void> {
  await gh.gh(input.cwd, ["auth", "status"]);

  const repoView = await gh.ghJson<{ nameWithOwner?: unknown }>(input.cwd, ["repo", "view", "--json", "nameWithOwner"]);
  const repoIdentity = gh.asString(repoView.nameWithOwner, "gh repo identity");

  const originUrl = (await gh.run(input.cwd, "git", ["config", "--get", "remote.origin.url"])).trim();
  const originIdentity = parseRepositoryIdentity(originUrl);
  if (originIdentity === null) {
    throw new PublicationAdapterError(`could not parse repository identity from remote.origin.url (${originUrl})`);
  }
  if (originIdentity !== repoIdentity) {
    throw new PublicationAdapterError(`repository identity mismatch: git remote is ${originIdentity}, gh resolves ${repoIdentity}`);
  }

  const [owner, name] = repoIdentity.split("/");
  if (!owner || !name) throw new PublicationAdapterError(`invalid repository identity ${repoIdentity}`);

  const permissionResponse = await gh.ghJson<{ data?: { repository?: { viewerPermission?: unknown } } }>(input.cwd, [
    "api",
    "graphql",
    "-f",
    `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){viewerPermission}}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ]);
  const permission = gh.asString(permissionResponse.data?.repository?.viewerPermission, "GitHub viewer permission");
  if (!["ADMIN", "MAINTAIN", "WRITE"].includes(permission)) {
    throw new PublicationAdapterError(`insufficient GitHub permission for PR publication (${permission})`);
  }

  const headSha = (await gh.run(input.cwd, "git", ["rev-parse", "HEAD"])).trim();
  await gh.gh(input.cwd, [
    "api",
    `repos/${repoIdentity}/commits/${headSha}/check-runs`,
    "-H",
    "Accept: application/vnd.github+json",
  ]);
}

async function ensureGhPullRequest(input: PublicationAdapterInput): Promise<PullRequest> {
  await gh.run(input.cwd, "git", ["push", "-u", "origin", input.job.branch]);

  const existing = await gh.ghJson<Array<{ number?: unknown; url?: unknown; state?: unknown }>>(input.cwd, [
    "pr",
    "list",
    "--head",
    input.job.branch,
    "--base",
    input.job.target,
    "--state",
    "open",
    "--json",
    "number,url,state",
  ]);

  let prNumber: number | null = null;
  if (existing.length > 0) {
    prNumber = gh.asNumber(existing[0]?.number, "open PR number");
  } else {
    const title = `[factory] ${input.job.id}: ${input.job.feature}`;
    const body = [
      "Automated publication by the Pi Agent Fabric Factory.",
      "",
      "- Target: develop",
      "- Merge policy: human merge required",
      "- Auto-merge: disabled",
    ].join("\n");
    await gh.gh(input.cwd, [
      "pr",
      "create",
      "--base",
      input.job.target,
      "--head",
      input.job.branch,
      "--title",
      title,
      "--body",
      body,
    ]);
  }

  const view = await gh.ghJson<{ url?: unknown; state?: unknown }>(input.cwd, [
    "pr",
    "view",
    prNumber === null ? input.job.branch : String(prNumber),
    "--json",
    "url,state",
  ]);

  return {
    url: gh.asString(view.url, "pull request url"),
    state: gh.asString(view.state, "pull request state"),
    merge_state: "WAITING_FOR_HUMAN",
  };
}

function parseRepositoryIdentity(remoteUrl: string): string | null {
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;

  const https = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (https) return `${https[1]}/${https[2]}`;

  return null;
}
