import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDecisionComplete, DecisionContractError, renderDecisionTemplate } from "../src/artifacts/decision.ts";

test("a decision with required independent-check sections passes the contract", () => {
  const parsed = assertDecisionComplete([
    "DECISION: APPROVE",
    "",
    "## Spec checks",
    "",
    "Acceptance criteria map to updated tests.",
    "",
    "## Implementation evidence",
    "",
    "Diff scoped to the API middleware and tests.",
    "",
    "## Policy context",
    "",
    "Target remains develop and human merge is still required.",
    "",
  ].join("\n"));

  assert.equal(parsed.decision, "APPROVE");
});

test("missing decision header or required sections fails closed", () => {
  assert.throws(
    () => assertDecisionComplete("## Spec checks\n\nDone."),
    DecisionContractError,
  );

  assert.throws(
    () => assertDecisionComplete("DECISION: ESCALATE\n\n## Spec checks\n\nDone."),
    DecisionContractError,
  );
});

test("the decision template scaffolds every required independent-check section", () => {
  const template = renderDecisionTemplate();
  assert.match(template, /^DECISION:\s*APPROVE$/m);
  assert.match(template, /^## Spec checks$/m);
  assert.match(template, /^## Implementation evidence$/m);
  assert.match(template, /^## Policy context$/m);
});
