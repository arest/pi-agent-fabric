/**
 * The `spec.md` artifact contract.
 *
 * `spec.md` is the durable specification produced by the spec-writer role and
 * consumed by the builder, reviewers, and approver. The orchestrator never
 * advances a job out of the `spec` stage until the artifact satisfies this
 * contract, so the shape is defined here as data rather than prose.
 *
 * Sections are ATX level-2 headings (`## Problem`). Heading matching is
 * case-insensitive and punctuation-insensitive. A section whose body is empty,
 * whitespace, or only an HTML comment counts as missing: a heading alone is
 * never a specification.
 */

/** Stable key for one required or recommended specification section. */
export type SpecSectionKey =
  | "problem"
  | "scope"
  | "acceptance_criteria"
  | "affected_areas"
  | "validation_commands"
  | "risks";

export interface SpecSection {
  key: SpecSectionKey;
  /** Canonical heading text used by the template and error messages. */
  title: string;
  /** Required sections gate the `spec -> build` transition. */
  required: boolean;
  /** Accepted heading spellings, normalized before matching. */
  aliases: readonly string[];
}

/**
 * The specification contract. `required: true` sections must be present and
 * non-empty before a job may advance to `build`. `affected_areas` is expected
 * by the full contract but stays advisory in this slice so a valid spec is not
 * blocked on a heading the ticket does not require.
 */
export const SPEC_SECTIONS: readonly SpecSection[] = [
  {
    key: "problem",
    title: "Problem",
    required: true,
    aliases: ["problem", "problem statement"],
  },
  {
    key: "scope",
    title: "Scope",
    required: true,
    aliases: ["scope", "scope and non-goals", "scope & non-goals"],
  },
  {
    key: "acceptance_criteria",
    title: "Acceptance criteria",
    required: true,
    aliases: ["acceptance criteria"],
  },
  {
    key: "affected_areas",
    title: "Affected areas",
    required: false,
    aliases: ["affected areas", "affected area"],
  },
  {
    key: "validation_commands",
    title: "Validation commands",
    required: true,
    aliases: ["validation commands", "validation"],
  },
  {
    key: "risks",
    title: "Risks and assumptions",
    required: true,
    aliases: ["risks", "risks and assumptions", "risks & assumptions", "assumptions and risks"],
  },
];

export const REQUIRED_SPEC_SECTIONS: readonly SpecSection[] = SPEC_SECTIONS.filter(
  (section) => section.required,
);

export interface ParsedSpec {
  /** Raw, trimmed body per recognized section. Duplicate headings are ignored. */
  sections: Partial<Record<SpecSectionKey, string>>;
  /** Recognized sections that were present with real content. */
  present: SpecSectionKey[];
  /** Required sections that were absent or empty. */
  missing: SpecSectionKey[];
  /** Canonical titles of the missing required sections, in contract order. */
  missingTitles: string[];
  /** Recognized-but-advisory sections that were absent or empty. */
  optionalMissing: SpecSectionKey[];
}

/** A specification that does not satisfy the required-section contract. */
export class SpecContractError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`spec.md is missing required sections: ${missing.join(", ")}`);
    this.name = "SpecContractError";
    this.missing = missing;
  }
}

/**
 * Normalize a heading or alias to a comparison key: lowercase alphanumerics
 * joined by single spaces, so `Risks & assumptions` matches `risks and
 * assumptions` and punctuation never changes identity.
 */
export function normalizeSectionHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const SECTION_BY_ALIAS: ReadonlyMap<string, SpecSectionKey> = (() => {
  const map = new Map<string, SpecSectionKey>();
  for (const section of SPEC_SECTIONS) {
    map.set(normalizeSectionHeading(section.title), section.key);
    for (const alias of section.aliases) map.set(normalizeSectionHeading(alias), section.key);
  }
  return map;
})();

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Parse a specification document against the contract.
 *
 * The parser fails neither on unknown headings nor on extra content; it reports
 * which required sections are missing. Content inside fenced code blocks never
 * counts as a heading, and HTML comments do not make an otherwise empty section
 * look complete. When a section heading appears more than once, the first
 * occurrence is the one that counts.
 */
export function parseSpec(markdown: string): ParsedSpec {
  const lines = markdown.replace(HTML_COMMENT, "").split("\n");
  const headings: Array<{ key: SpecSectionKey; index: number }> = [];

  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "")[0] ?? "";
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const headingMatch = ATX_HEADING.exec(line);
    if (!headingMatch || (headingMatch[1] ?? "").length !== 2) continue;
    const key = SECTION_BY_ALIAS.get(normalizeSectionHeading(headingMatch[2] ?? ""));
    if (key) headings.push({ key, index });
  }

  const sections: Partial<Record<SpecSectionKey, string>> = {};
  headings.forEach((heading, position) => {
    if (sections[heading.key] !== undefined) return; // First occurrence wins.
    const end = position + 1 < headings.length ? (headings[position + 1]?.index ?? lines.length) : lines.length;
    const body = lines.slice(heading.index + 1, end).join("\n").trim();
    sections[heading.key] = body;
  });

  const present: SpecSectionKey[] = [];
  const missing: SpecSectionKey[] = [];
  const optionalMissing: SpecSectionKey[] = [];
  for (const section of SPEC_SECTIONS) {
    const body = sections[section.key];
    if (typeof body === "string" && body.length > 0) {
      present.push(section.key);
    } else if (section.required) {
      missing.push(section.key);
    } else {
      optionalMissing.push(section.key);
    }
  }

  return {
    sections,
    present,
    missing,
    missingTitles: missing.map(
      (key) => SPEC_SECTIONS.find((section) => section.key === key)?.title ?? key,
    ),
    optionalMissing,
  };
}

/** Parse and require the contract; throw {@link SpecContractError} if incomplete. */
export function assertSpecComplete(markdown: string): ParsedSpec {
  const parsed = parseSpec(markdown);
  if (parsed.missing.length > 0) throw new SpecContractError(parsed.missingTitles);
  return parsed;
}

/**
 * Render the spec-writer scaffold: every contract heading, empty bodies, and a
 * note outside the sections. The scaffold deliberately does not satisfy the
 * contract, so it can never advance a job on its own.
 */
export function renderSpecTemplate(feature: string): string {
  const title =
    feature.replace(/\s+/g, " ").replace(/[#`]/g, "").trim() || "Untitled feature";
  return [
    `# Specification: ${title}`,
    "",
    "<!-- Fill every section below. An empty section counts as missing, so this scaffold does not pass the spec gate. -->",
    "",
    "## Problem",
    "",
    "## Scope",
    "",
    "## Acceptance criteria",
    "",
    "## Affected areas",
    "",
    "## Validation commands",
    "",
    "## Risks and assumptions",
    "",
  ].join("\n");
}
