import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSpecComplete,
  parseSpec,
  renderSpecTemplate,
  REQUIRED_SPEC_SECTIONS,
  SpecContractError,
} from "../src/artifacts/spec.ts";
import { completeSpecMarkdown } from "./helpers/harness.ts";

test("a complete spec satisfies the required-section contract", () => {
  const parsed = assertSpecComplete(completeSpecMarkdown());

  assert.deepEqual(parsed.missing, []);
  assert.deepEqual(parsed.missingTitles, []);
  assert.deepEqual(
    [...parsed.present].sort(),
    [...REQUIRED_SPEC_SECTIONS.map((section) => section.key), "affected_areas"].sort(),
  );
  assert.equal(parsed.sections.problem?.includes("Rate limiting"), true);
});

test("each required section is reported by its canonical title when absent", () => {
  for (const section of REQUIRED_SPEC_SECTIONS) {
    const markdown = completeSpecMarkdown({ [section.title]: "" });
    assert.throws(
      () => assertSpecComplete(markdown),
      (error: unknown) => {
        assert.ok(error instanceof SpecContractError);
        assert.deepEqual(error.missing, [section.title]);
        return true;
      },
    );
  }
});

test("a heading with no body, whitespace, or only a comment is missing", () => {
  const cases: Record<string, string> = {
    empty: "",
    whitespace: "   \n\t\n",
    comment: "<!-- TODO -->",
    "comment and whitespace": "\n  <!-- describe the problem -->\n\n",
  };

  for (const [label, body] of Object.entries(cases)) {
    const parsed = parseSpec(completeSpecMarkdown({ Problem: body }));
    assert.deepEqual(parsed.missing, ["problem"], `section body ${label} must count as missing`);
  }
});

test("headings are matched case-insensitively with aliases and punctuation", () => {
  const markdown = [
    "# Spec",
    "## problem statement:",
    "One client can exhaust the API.",
    "## Scope & non-goals",
    "Add per-key limits.",
    "## acceptance criteria",
    "- [ ] 429 above the limit.",
    "## Validation",
    "npm test",
    "## risks & assumptions",
    "Gateway forwards client keys.",
  ].join("\n");

  const parsed = assertSpecComplete(markdown);
  assert.deepEqual(parsed.missing, []);
  assert.deepEqual(parsed.optionalMissing, ["affected_areas"]);
});

test("a heading inside a fenced code block is not a section", () => {
  const markdown = [
    "## Problem",
    "One client can exhaust the API.",
    "```md",
    "## Scope",
    "## Acceptance criteria",
    "## Validation commands",
    "## Risks and assumptions",
    "```",
    "## Scope",
    "Add per-key limits.",
    "## Acceptance criteria",
    "- [ ] 429.",
    "## Validation commands",
    "npm test",
    "## Risks and assumptions",
    "Gateway forwards keys.",
  ].join("\n");

  const parsed = assertSpecComplete(markdown);
  assert.deepEqual(parsed.missing, []);
  assert.equal(parsed.sections.scope, "Add per-key limits.");
});

test("CRLF documents parse the same as LF documents", () => {
  const lf = completeSpecMarkdown();
  const parsed = parseSpec(lf.replace(/\n/g, "\r\n"));
  assert.deepEqual(parsed.missing, []);
  assert.equal(parsed.present.length, 6);
});

test("a repeated section heading is read once, first occurrence wins", () => {
  const markdown = `${completeSpecMarkdown()}\n## Problem\n\nA contradicting second problem.\n`;
  const parsed = assertSpecComplete(markdown);
  assert.equal(parsed.sections.problem, "Rate limiting is missing, so one client can exhaust the API.");
});

test("the scaffold contains every contract heading and never passes the gate", () => {
  const template = renderSpecTemplate("Add rate limiting\n## Problem: injected");
  for (const section of REQUIRED_SPEC_SECTIONS) {
    assert.match(template, new RegExp(`^## ${section.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }

  const parsed = parseSpec(template);
  assert.deepEqual(
    parsed.missing,
    REQUIRED_SPEC_SECTIONS.map((section) => section.key),
    "the empty scaffold must not satisfy the contract",
  );
  assert.equal(template.includes("## Problem: injected"), false, "feature text must not inject headings");
});
