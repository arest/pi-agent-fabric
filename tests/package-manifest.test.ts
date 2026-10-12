import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import factoryExtension from "../extensions/factory.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

type Manifest = {
  name: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[]; skills?: string[] };
};

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as Manifest;
}

test("the manifest is a Pi package that exposes the extension and skill", async () => {
  const manifest = await readManifest();

  assert.match(manifest.name, /^@[^/]+\/pi-agent-fabric-factory$/);
  assert.ok(manifest.keywords?.includes("pi-package"), "expected the pi-package keyword");
  assert.deepEqual(manifest.pi?.extensions, ["./extensions/factory.ts"]);
  assert.deepEqual(manifest.pi?.skills, ["./skills"]);

  const extensionExists = await fs
    .access(path.join(repoRoot, "extensions", "factory.ts"))
    .then(() => true)
    .catch(() => false);
  assert.ok(extensionExists, "declared extension file must exist");
});

test("Pi host packages stay out of dependencies", async () => {
  const manifest = await readManifest();

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    assert.ok(!name.startsWith("@earendil-works/"), `${name} must not be a runtime dependency`);
  }
  assert.ok(
    manifest.peerDependencies?.["@earendil-works/pi-coding-agent"],
    "the Pi coding agent host must be declared as a peer dependency",
  );
});

test("the extension default export is a Pi extension factory", () => {
  assert.equal(typeof factoryExtension, "function");
});

test("the bundled skill and its references are present and well formed", async () => {
  const skillPath = path.join(repoRoot, "skills", "factory", "SKILL.md");
  const skill = await fs.readFile(skillPath, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? "";
  assert.match(frontmatter, /^name:\s*factory$/m);
  assert.match(frontmatter, /^description:\s*\S/m);

  for (const relative of [
    "references/state-machine.md",
    "references/agent-contracts.md",
    "references/github-policy.md",
  ]) {
    const exists = await fs
      .access(path.join(repoRoot, "skills", "factory", relative))
      .then(() => true)
      .catch(() => false);
    assert.ok(exists, `missing skill reference ${relative}`);
  }
});

test("the package ships no Claude-specific runtime assumptions", async () => {
  const manifest = await readManifest();
  assert.ok(!JSON.stringify(manifest).includes("claude"));

  const claudeDir = await fs
    .stat(path.join(repoRoot, ".claude"))
    .then(() => true)
    .catch(() => false);
  assert.ok(!claudeDir, "the factory must not depend on Claude Code conventions");
});
