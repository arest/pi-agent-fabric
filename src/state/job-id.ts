import type { Board } from "./board.ts";

/**
 * Derive a filesystem- and branch-safe slug from a feature request.
 * Feature text is untrusted input, so the result contains only `[a-z0-9-]`.
 */
export function slugify(feature: string): string {
  const ascii = feature
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const limited = ascii.slice(0, 48).replace(/-+$/g, "");
  return limited.length > 0 ? limited : "job";
}

/**
 * Allocate the next sequential job id (`NNN-slug`).
 *
 * Callers must run this inside the board write lock so two concurrent starts
 * cannot allocate the same sequence.
 */
export function allocateJobId(board: Board, feature: string): string {
  let highest = 0;
  for (const job of board.jobs) {
    const match = /^(\d+)-/.exec(job.id);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  const sequence = String(highest + 1).padStart(3, "0");
  return `${sequence}-${slugify(feature)}`;
}
