/**
 * Shared workflow errors, typed so the command surface can report a precise,
 * non-leaking message and tests can assert on the failure mode rather than a
 * string.
 */

/** No job with the requested id exists on the board. */
export class JobNotFoundError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`no factory job ${jobId} on the board`);
    this.name = "JobNotFoundError";
    this.jobId = jobId;
  }
}

/** `spec.md` does not exist where the spec stage expects the spec-writer to have put it. */
export class SpecNotFoundError extends Error {
  readonly specFile: string;

  constructor(specFile: string) {
    super(`spec.md was not found at ${specFile}`);
    this.name = "SpecNotFoundError";
    this.specFile = specFile;
  }
}

/**
 * A workflow step ran against a job in the wrong stage or status. Transitions
 * are rejected without mutating state, so the caller never has to repair a
 * half-applied change.
 */
export class InvalidJobStateError extends Error {
  readonly jobId: string;
  readonly stage: string;
  readonly status: string;
  readonly expected: string;

  constructor(jobId: string, expected: string, stage: string, status: string) {
    super(`factory job ${jobId} is ${stage}/${status}; expected ${expected}`);
    this.name = "InvalidJobStateError";
    this.jobId = jobId;
    this.stage = stage;
    this.status = status;
    this.expected = expected;
  }
}

/**
 * An operator command was requested for a job whose durable state does not
 * permit it. The transition is rejected without mutating the board so the
 * operator gets an explicit, non-guessing failure.
 */
export class CommandNotEligibleError extends Error {
  readonly command: string;
  readonly jobId: string;
  readonly reason: string;
  readonly stage: string;
  readonly status: string;

  constructor(command: string, jobId: string, reason: string, stage: string, status: string) {
    super(`cannot ${command} factory job ${jobId}: ${reason} (job is ${stage}/${status})`);
    this.name = "CommandNotEligibleError";
    this.command = command;
    this.jobId = jobId;
    this.reason = reason;
    this.stage = stage;
    this.status = status;
  }
}

/**
 * An operator command was well-formed but the request itself is unusable, for
 * example a `rework` with no note. Reported as usage by the command surface.
 */
export class OperatorRequestError extends Error {
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = "OperatorRequestError";
    this.command = command;
  }
}

/**
 * A rework round could not reconstruct the previous round's retained review
 * evidence. The factory must not resume a builder on incomplete findings, so
 * the job escalates to a human instead of guessing.
 */
export class ReworkContextError extends Error {
  readonly jobId: string;
  readonly round: number;
  readonly reason: string;

  constructor(jobId: string, round: number, reason: string) {
    super(`factory job ${jobId} cannot open rework round ${round}: ${reason}`);
    this.name = "ReworkContextError";
    this.jobId = jobId;
    this.round = round;
    this.reason = reason;
  }
}
