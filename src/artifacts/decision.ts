/** Durable contract for approver decisions. */
export const APPROVAL_DECISIONS = ["APPROVE", "ESCALATE"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

const REQUIRED_SECTIONS = ["Spec checks", "Implementation evidence", "Policy context"] as const;

export interface ParsedDecision {
  decision: ApprovalDecision;
  markdown: string;
}

export class DecisionContractError extends Error {
  readonly decisionFile: string;
  readonly missing: string[];

  constructor(decisionFile: string, missing: string[]) {
    super(`approval decision ${decisionFile} is incomplete; missing: ${missing.join(", ")}`);
    this.name = "DecisionContractError";
    this.decisionFile = decisionFile;
    this.missing = missing;
  }
}

function headingKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Validate an approver decision without interpreting approver prose. */
export function assertDecisionComplete(markdown: string, decisionFile = "decision.md"): ParsedDecision {
  const decision = /^DECISION:\s*(APPROVE|ESCALATE)\s*$/m.exec(markdown)?.[1] as ApprovalDecision | undefined;
  const missing: string[] = [];
  if (!decision) missing.push("DECISION");

  const sections = new Map<string, string>();
  const headings = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const title = headings[index]?.[1] ?? "";
    const key = headingKey(title);
    if (sections.has(key)) continue;
    const start = (headings[index]?.index ?? 0) + (headings[index]?.[0].length ?? 0);
    const end = headings[index + 1]?.index ?? markdown.length;
    sections.set(key, markdown.slice(start, end).replace(/<!--[\s\S]*?-->/g, "").trim());
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!sections.get(headingKey(section))) missing.push(section);
  }

  if (missing.length > 0 || !decision) throw new DecisionContractError(decisionFile, missing);
  return { decision, markdown };
}

export function renderDecisionTemplate(): string {
  return [
    "# Approval decision",
    "",
    "DECISION: APPROVE",
    "",
    "## Spec checks",
    "",
    "<!-- Confirm acceptance criteria and scope against spec.md. -->",
    "",
    "## Implementation evidence",
    "",
    "<!-- Confirm diff scope, build evidence, and reviewer reports. -->",
    "",
    "## Policy context",
    "",
    "<!-- Confirm branch target and policy constraints. -->",
    "",
  ].join("\n");
}
