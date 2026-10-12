/** Required durable evidence headings in a builder's build.md. */
export const REQUIRED_BUILD_SECTIONS = ["Changed files", "Validation", "Remaining risks"] as const;

export class BuildEvidenceError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`build.md is incomplete; missing: ${missing.join(", ")}`);
    this.name = "BuildEvidenceError";
    this.missing = missing;
  }
}

function headingKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Validate build evidence without interpreting its prose. */
export function assertBuildComplete(markdown: string): void {
  const sections = new Map<string, string>();
  const heading = /^##\s+(.+?)\s*$/gm;
  const matches = [...markdown.matchAll(heading)];
  for (let index = 0; index < matches.length; index += 1) {
    const title = matches[index]?.[1] ?? "";
    const key = headingKey(title);
    if (sections.has(key)) continue;
    const start = (matches[index]?.index ?? 0) + (matches[index]?.[0].length ?? 0);
    const end = matches[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(start, end).replace(/<!--[\s\S]*?-->/g, "").trim();
    sections.set(key, body);
  }

  const missing = REQUIRED_BUILD_SECTIONS.filter((section) => {
    const body = sections.get(headingKey(section));
    return body === undefined || body.length === 0;
  });
  if (missing.length > 0) throw new BuildEvidenceError([...missing]);
}

export function renderBuildTemplate(): string {
  return [
    "# Build evidence",
    "",
    "## Changed files",
    "",
    "<!-- List each application or test file changed by the builder. -->",
    "",
    "## Validation",
    "",
    "<!-- Record every configured validation command and its outcome. -->",
    "",
    "## Remaining risks",
    "",
    "<!-- Record risks, assumptions, or explicitly state none. -->",
    "",
  ].join("\n");
}
