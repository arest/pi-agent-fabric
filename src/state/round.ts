/**
 * One definition of a valid review-round number, shared by every parser and
 * writer so the board and the job event log cannot drift apart.
 */
export function isValidRound(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
