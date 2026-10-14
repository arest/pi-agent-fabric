---
id: M1
phase: 8
sequence: 1
slug: policy-selected-command-execution
verdict: valid
status: valid
severity: medium
severity_original: HIGH
poc_status: executed
pre_fp_flag: none
debate: piolium/attack-surface/balanced-chamber-summary.md
original_id: p8-001
---

# Repository policy can select an arbitrary validation executable

## Summary
A repository-controlled validation command is executed with the factory user's privileges without an executable allowlist, trusted PATH resolution, environment scrubbing, or resource limits.

## Location
- `src/config/policy.ts:101-118` accepts repository `test_commands` after only schema checks and shell-metacharacter rejection.
- `src/workflow/build-stage.ts:140-147` executes each configured command.
- `src/workflow/build-stage.ts:271-284` tokenizes the command and invokes `execFileAsync` in the prepared worktree.

## Attacker Control
A contributor or local attacker who can modify the checkout can set `.pi/factory.json.repository.test_commands[].command` to an absolute executable or a program resolved through the inherited `PATH`. The attacker must induce a local operator or automation to run the build stage.

## Trust Boundary Crossed
Repository-controlled policy and worktree contents cross into local process execution under the factory user's OS identity and inherited environment.

## Impact
The selected program can read available environment credentials and local files, modify repository/factory state, exfiltrate data, or consume local resources. This is not an unauthenticated remote RCE; it requires an untrusted or attacker-modifiable checkout and a build invocation.

## Evidence
`loadPolicy` rejects shell syntax but does not constrain the executable. `runBuildStage` invokes every accepted command, and `runConfiguredValidation` passes the first token as the executable to `execFileAsync(executable, parts, { cwd, maxBuffer })`. `execFile` blocks shell interpretation but does not establish executable trust or isolate the environment.

## Reproduction Steps
1. In a checkout used by the factory, add a `test_commands` entry whose command names an attacker-controlled executable or absolute program path.
2. Start a job and advance it to the build stage.
3. Run the build workflow; observe the configured executable run from the prepared worktree with inherited process privileges/environment.
4. The shell-character filter and `execFile` prevent shell metacharacter injection, but no allowlist or environment/resource boundary prevents the selected program from executing.

The defense review confirmed the existing controls: shell syntax rejection, non-shell `execFile`, worktree isolation, and a 4 MiB output cap. Those controls do not address arbitrary executable selection, inherited secrets, timeouts, or process-tree cleanup. Debate: `piolium/attack-surface/balanced-chamber-summary.md`.


PoC-Status: executed
Protocol: local
Auth-Required: no
Auth-Roles-Required: anonymous
