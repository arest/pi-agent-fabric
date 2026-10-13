/** Durable contract for reviewer reports. */
export const REVIEW_VERDICTS = ["PASS", "CHANGES"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_SEVERITIES = ["BLOCKING", "NON-BLOCKING"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export interface ParsedReview {
  verdict: ReviewVerdict;
  severity: ReviewSeverity;
  markdown: string;
}

export class ReviewContractError extends Error {
  readonly reportFile: string;
  readonly missing: string[];

  constructor(reportFile: string, missing: string[]) {
    super(`review report ${reportFile} is incomplete; missing: ${missing.join(", ")}`);
    this.name = "ReviewContractError";
    this.reportFile = reportFile;
    this.missing = missing;
  }
}

const REQUIRED_SECTIONS = ["Summary", "Findings", "Evidence", "Recommendations"] as const;

function headingKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Validate a report without interpreting reviewer prose. */
export function assertReviewComplete(markdown: string, reportFile = "review report"): ParsedReview {
  const verdict = /^VERDICT:\s*(PASS|CHANGES)\s*$/m.exec(markdown)?.[1] as ReviewVerdict | undefined;
  const severity = /^SEVERITY:\s*(BLOCKING|NON-BLOCKING)\s*$/m.exec(markdown)?.[1] as ReviewSeverity | undefined;
  const missing: string[] = [];
  if (!verdict) missing.push("VERDICT");
  if (!severity) missing.push("SEVERITY");

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
  if (verdict === "PASS" && severity === "BLOCKING") missing.push("consistent PASS severity");
  if (missing.length > 0 || !verdict || !severity) throw new ReviewContractError(reportFile, missing);
  return { verdict, severity, markdown };
}

export function renderReviewTemplate(role: string): string {
  return [
    `# ${role} review`,
    "",
    "VERDICT: PASS",
    "SEVERITY: NON-BLOCKING",
    "",
    "## Summary",
    "",
    "<!-- Summarize the review scope and outcome. -->",
    "",
    "## Findings",
    "",
    "<!-- List findings, or explicitly state none. -->",
    "",
    "## Evidence",
    "",
    "<!-- Link to files, tests, or commands inspected. -->",
    "",
    "## Recommendations",
    "",
    "<!-- List follow-up recommendations, or explicitly state none. -->",
    "",
  ].join("\n");
}
