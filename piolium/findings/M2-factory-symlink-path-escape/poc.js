#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { startJob } = await import(pathToFileURL(path.resolve(here, "../../../src/workflow/start-job.ts")).href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-symlink-poc-"));
const redirected = await fs.mkdtemp(path.join(os.tmpdir(), "factory-redirected-"));

try {
  await fs.mkdir(path.join(root, "factory"));
  await fs.symlink(redirected, path.join(root, "factory", "jobs"), "dir");

  const result = await startJob({ cwd: root, feature: "symlink escape proof" });
  const escapedEvents = path.join(redirected, path.basename(result.jobDir), "events.jsonl");
  const inRepoEvents = path.join(root, "factory", "jobs", path.basename(result.jobDir), "events.jsonl");
  const event = await fs.readFile(escapedEvents, "utf8");
  const escapedOutsideRoot = (await fs.realpath(escapedEvents)).startsWith(`${root}${path.sep}`) === false;

  console.log(`job=${result.job.id}`);
  console.log(`reported_job_dir=${result.jobDir}`);
  console.log(`redirected_event=${await fs.realpath(escapedEvents)}`);
  console.log(`event_contains_job_id=${event.includes(`"job_id":"${result.job.id}"`)}`);
  console.log(`outside_repository_root=${escapedOutsideRoot}`);
  console.log(`same_path_visible_through_symlink=${(await fs.realpath(inRepoEvents)) === (await fs.realpath(escapedEvents))}`);
  console.log(JSON.stringify({
    status: escapedOutsideRoot && event.includes(`"job_id":"${result.job.id}"`) ? "confirmed" : "failed",
    evidence: "job event written through factory/jobs symlink outside repository root",
    notes: `redirect=${await fs.realpath(escapedEvents)}`,
  }));
} catch (error) {
  console.log(`error=${error instanceof Error ? error.stack : String(error)}`);
  console.log(JSON.stringify({ status: "inconclusive", evidence: "runtime did not complete symlink redirection test" }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(redirected, { recursive: true, force: true });
}
