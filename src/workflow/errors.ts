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
