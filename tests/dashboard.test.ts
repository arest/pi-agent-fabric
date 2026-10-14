import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";

const dashboardFile = path.join(process.cwd(), "factory", "dashboard.html");

test("dashboard is a self-contained read-only board view", async () => {
  const source = await fs.readFile(dashboardFile, "utf8");

  assert.match(source, /Read-only operational dashboard/);
  assert.match(source, /fetch\(`board\.json\?ts=\$\{Date\.now\(\)\}`/);
  assert.match(source, /method: "GET"/);
  assert.match(source, /setInterval\(poll, 5000\)/);
  for (const requiredLabel of ["Reviewers", "Pull request / CI", "Artifacts", "History"]) {
    assert.match(source, new RegExp(requiredLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  // A dashboard may navigate to evidence, but it must not expose workflow
  // mutation controls or send mutation requests.
  assert.doesNotMatch(source, /fetch\([^)]*(POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(source, /\b(?:approve|rework|merge|cancel)\b/i);
});

test("dashboard renders board values as text and constrains external links", async () => {
  const source = await fs.readFile(dashboardFile, "utf8");

  assert.match(source, /textContent/);
  assert.match(source, /href\.startsWith\("jobs\/"\)/);
  assert.match(source, /\^https\?:\\\/\\\//i);
  assert.match(source, /noopener noreferrer/);

  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "dashboard must contain an inline script");
  assert.doesNotThrow(() => new vm.Script(script), "dashboard script must parse as JavaScript");
});
