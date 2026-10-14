# [M1] Repository policy can select an arbitrary validation executable

## Summary
A repository-controlled `test_commands[].command` value is executed during the factory build stage with the factory user's process identity and inherited environment. The policy parser rejects shell metacharacters, but it does not restrict which executable may be selected, scrub sensitive environment variables, impose a timeout, or otherwise sandbox the process. A contributor or other actor able to modify a checkout can therefore cause a local operator or automation running that checkout to execute an arbitrary program.

**Severity:** Medium  
**PoC status:** Executed  
**Authentication:** No application authentication is involved; exploitation requires an attacker-controlled or attacker-modifiable checkout and a build invocation.

## Details
The repository policy accepts each validation command after checking that it is a non-empty string and does not contain selected shell syntax. The validation is not an executable allowlist: relative paths, absolute paths, and names resolved through the inherited `PATH` remain valid. The relevant parser in [`src/config/policy.ts`](https://github.com/arest/pi-agent-fabric/blob/7491206657accbfa06cbf56e5b4ee453ee28620b/src/config/policy.ts#L101-L118) returns the command unchanged:

```ts
if (/[\0\r\n;&|`$><()]/.test(command.command)) {
  throw new PolicyError(`policy.repository.test_commands[${index}].command contains unsafe shell syntax`);
}
return { name: command.name, command: command.command };
```

Importantly, there is no check that the first token is an approved validation tool or that it resolves to a trusted location. During the build stage, every accepted policy command is passed to the validation runner, as shown in [`src/workflow/build-stage.ts`](https://github.com/arest/pi-agent-fabric/blob/7491206657accbfa06cbf56e5b4ee453ee28620b/src/workflow/build-stage.ts#L140-L147):

```ts
for (const command of policy.repository.test_commands) {
  const result = await runValidation(command, prepared.path);
  validation.push(result);
  await mergeValidationEvidence(buildFile, validation);
  if (result.outcome === "FAIL") {
    // ... stop the build
  }
}
```

The runner splits the repository-selected string, treats its first token as the executable, and invokes it directly. [`runConfiguredValidation`](https://github.com/arest/pi-agent-fabric/blob/7491206657accbfa06cbf56e5b4ee453ee28620b/src/workflow/build-stage.ts#L228-L238) uses `execFile`, which avoids shell interpretation but does not make the executable trustworthy and does not remove inherited environment variables:

```ts
const parts = command.command.trim().split(/\s+/);
const executable = parts.shift();
if (!executable) return { ...command, outcome: "FAIL", output: "empty command" };
try {
  const result = await execFileAsync(executable, parts, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { ...command, outcome: "PASS", output: `${result.stdout}${result.stderr}`.trim() };
}
```

Thus, the shell-syntax filter prevents one class of shell injection, and `execFile` prevents shell expansion, but neither control prevents a repository policy from selecting a malicious executable directly.

## Root Cause
The design treats repository policy as data that will eventually be handled by a named-task adapter, while the current implementation already executes the command value as an operating-system program. Validation is limited to syntax and schema shape rather than executable identity and execution isolation. The trust boundary is therefore crossed when untrusted repository configuration is converted into an `execFile` executable under the factory user's privileges.

## Proof of Concept (PoC)
The executed PoC is [`piolium/findings/M1-policy-selected-command-execution/poc.mjs`](piolium/findings/M1-policy-selected-command-execution/poc.mjs). It creates a temporary checkout containing:

1. `.pi/factory.json` with `repository.test_commands[0].command` set to `./.pi/attacker-validation.mjs`.
2. `.pi/attacker-validation.mjs`, an attacker-controlled executable that writes a proof file and prints a marker.
3. An inherited environment variable, `POC_INHERITED_SECRET=poc-inherited-secret`.

It then starts a job, advances it through the spec stage, and runs the build stage. The shortest reproduction is:

```sh
POC_INHERITED_SECRET=poc-inherited-secret \\
  node piolium/findings/M1-policy-selected-command-execution/poc.mjs
```

The run completed successfully (`exit=0`) and advanced the job to `review`. The decisive captured result was:

```json
{
  "validation": {
    "name": "repository validation",
    "command": "./.pi/attacker-validation.mjs",
    "outcome": "PASS",
    "output": "ATTACKER_VALIDATOR_EXECUTED"
  },
  "payload_proof": {
    "executed": true,
    "inherited": "poc-inherited-secret",
    "uid": 501
  }
}
```

This demonstrates both arbitrary repository-selected program execution and inheritance of a caller-provided secret. The PoC does not rely on shell metacharacters or shell interpretation.

## Impact
An attacker who can alter a checkout can execute code whenever a trusted local operator or automation runs the factory build stage for that checkout. The selected program runs as the factory user's OS identity, can read files and environment variables accessible to that identity, can alter the worktree or factory state, and can exfiltrate any reachable credentials. It can also consume local CPU, memory, or processes; the existing 4 MiB output cap limits captured output but does not provide a timeout or process-tree cleanup.

The demonstrated effect is local command execution, not unauthenticated remote RCE: the attacker must first influence the repository and cause a build invocation. The practical risk is highest where automated builds process contributor-controlled repositories while exposing deployment credentials, cloud credentials, signing material, or broad filesystem access.

## Remediation
Treat repository-provided validation commands as untrusted task identifiers rather than executable strings. Use a fixed allowlist mapping approved names to trusted absolute executable paths and fixed argument templates; reject paths, path separators, and unknown names. Run validation in a dedicated low-privilege sandbox with a minimal environment, explicit resource limits, a wall-clock timeout, and reliable process-group cleanup. In particular, do not pass the factory process environment through by default, and ensure credentials are unavailable to repository-controlled validation processes.

If arbitrary repository-defined validators are a required feature, execute them in an isolated disposable container or equivalent sandbox with no sensitive mounts or credentials, bounded CPU/memory/disk/network access, and an explicit policy gate before execution.
