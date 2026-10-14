# Local testing and npm publication

Purpose: record the verified end‑to‑end procedure for (a) testing this Pi package
locally — running its own suite and loading the real `/factory` extension and
skill into a real Pi session from this checkout — and (b) publishing
`@arest/pi-agent-fabric-factory` to npm so it installs with `pi install`.

Verified against, on macOS (arm64):

| Tool | Version | Source |
|---|---|---|
| Node.js | v24.5.0 | `node -v` |
| npm | 11.5.1 | `npm -v` |
| TypeScript (`tsc`) | 5.9.3 | `tsc -v` (repo `devDependencies.typescript: ^5.9.3`) |
| Pi CLI | 1.2.0 | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` (the `pi` on `PATH`) |
| `@earendil-works/pi-coding-agent` (repo devDep) | 1.1.0 | `node_modules/@earendil-works/pi-coding-agent/package.json` |

Citations point at repo‑relative paths. `node_modules/@earendil-works/pi-coding-agent/…`
is the Pi package that ships the Pi docs and unbundled source; `/opt/homebrew/lib/node_modules/npm/docs/content/…`
is the documentation shipped with npm 11.5.1. Where a claim could not be traced
to a primary source it is marked **[unverified]**.

---

## Testing locally

The package has two independent local‑testing surfaces:

1. the repo's own Node test/typecheck suite;
2. loading the shipped extension and skill into a real Pi session.

Per Pi's own docs, a package is "an ordinary directory or npm package" that
"can expose conventional resource directories, declare explicit paths under the
`pi` key in `package.json`" (`node_modules/@earendil-works/pi-coding-agent/docs/packages.md:5`).
This repo does the latter in `package.json`:

```json
"pi": { "extensions": ["./extensions/factory.ts"], "skills": ["./skills"] }
```

### 1. Run the repo suite

```bash
npm install          # only needed once, or after dependency changes
npm run typecheck    # tsc --noEmit
npm test             # node --test "tests/**/*.test.ts"
npm run check        # typecheck + tests
```

`package.json` defines exactly those three scripts, and `npm run check`
is `npm run typecheck && npm test`.

- Verified first‑hand: `npm run check` exits 0 on this checkout; the suite reports
  **124 tests, 124 pass, 0 fail** (~8.3 s).
- The tests run TypeScript directly with no transpile step because Node ≥24 does
  type stripping by default (`nodejs.org/api/typescript.html`: type stripping is
  enabled by default since v23.6.0/v22.18.0 and stable since v24.12.0). The repo
  relies on this, which is why `package.json` declares `engines.node: ">=24"` and
  the README says "Requires Node 24+ (tests run TypeScript directly through native type stripping)." (`README.md:104`).
- `tsconfig.json` sets `noEmit: true`, `erasableSyntaxOnly: true`, and
  `allowImportingTsExtensions: true`. `erasableSyntaxOnly` forces the source to
  stay inside what type stripping can erase (no enums/namespaces/parameter
  properties), which is what keeps both the tests and Pi's runtime loader working
  from raw `.ts` with no build output.

### 2. Load the real extension + skill into a real Pi session

#### What `pi install <local-path>` actually does

Source of truth: the installed CLI. `DefaultPackageManager.install()` treats a
local source as a no‑op after a path‑existence check — it never copies or
symlinks:

```js
// dist/core/package-manager.js  (install(), lines 796-802)
if (parsed.type === "local") {
    const resolved = this.resolvePath(parsed.path);
    if (!existsSync(resolved)) {
        throw new Error(`Path does not exist: ${resolved}`);
    }
    return;                     // <-- nothing is copied
}
```

This matches Pi's documented source table: Local `./pi-tools` is "Loaded from the
resolved path without copying" (`docs/packages.md:36`). The npm and git sources,
by contrast, are installed under the Pi npm directory, and git checkouts are
cloned (`docs/packages.md:32-36`).

`pi install` then persists the source into settings via
`addSourceToSettings`. For a local path the stored value is a path **relative to
the settings file's directory** (`normalizePackageSourceForSettings`,
`dist/core/package-manager.js:1160-1170`):

```js
const baseDir = this.getBaseDirForScope(scope);   // agentDir (user) or <cwd>/.pi (project)
const rel = relative(baseDir, resolved);
return rel || ".";
```

Pi documents the same rule: "Relative local paths resolve from the settings file
that contains them" (`docs/packages.md:38`). Verified first‑hand with an isolated
agent dir (`PI_CODING_AGENT_DIR=/tmp/pi-dev-agent`, so the real global config was
never touched — see `docs/environment-variables.md`, `PI_CODING_AGENT_DIR`):

```bash
$ pi install ./
Installing ./...
Installed ./

$ cat /tmp/pi-dev-agent/settings.json
{ "packages": [ "../../Users/andrea/Sites/pi-agent-fabric" ] }

$ pi list
User packages:
  ../../Users/andrea/Sites/pi-agent-fabric
    /Users/andrea/Sites/pi-agent-fabric
```

So: local path accepted, no copy, no build step, no npm call, stored as a
settings‑relative path, and `pi list` resolves it back to the checkout. A local
install is read from the working tree on every start, so **you do not re‑run
`pi install` after editing files**.

There is no "install" build step anywhere in this path because Pi loads extensions
through `jiti`: "Pi uses `jiti`, so local TypeScript extensions do not need a
separate compilation step" (`docs/extensions.md:38`; loader at
`dist/core/extensions/loader.js`, `loadExtensionModule` at `:461`, with `moduleCache: false` at `:478`
and jiti aliases that map `@earendil-works/pi-coding-agent` to the running Pi).

#### Recommended flows

Persistent local install (uses the `pi` manifest):

```bash
# user-scope install (writes ~/.pi/agent/settings.json)
pi install /Users/andrea/Sites/pi-agent-fabric

# or project-scope install (writes ./.pi/settings.json; needs project trust, -a/--approve)
pi install -l /Users/andrea/Sites/pi-agent-fabric
```

One‑shot, no settings change (best for iterating on a single file):

```bash
pi --extension ./extensions/factory.ts --skill ./skills
# short form:
pi -e ./extensions/factory.ts --skill ./skills
```

`pi -e` / `--extension` loads a file or `builtin:<name>` for one invocation and
`--skill` loads a skill file or directory, neither of which persists
(`pi --help`; `docs/cli.md`; `docs/packages.md:23-26`). `docs/extensions.md:35`
uses the same `pi --extension ./hello.ts` form for development.

To smoke‑test exactly what npm consumers will receive, pack first and install the
unpacked tarball (this is a local‑directory install, so it still does not copy):

```bash
npm pack --pack-destination /tmp/factory-pack
cd /tmp/factory-pack && tar -xzf arest-pi-agent-fabric-factory-0.1.0.tgz
pi install /tmp/factory-pack/package
```

Verified first‑hand: after the above, Pi's resolver reports
`/tmp/factory-pack/package/extensions/factory.ts` and
`/tmp/factory-pack/package/skills/factory/SKILL.md`, i.e. the published file set
(`files` allowlist) is sufficient for Pi to discover both resources.

#### How to verify extension + skill registration

`pi install` only records the source; the actual resource discovery happens at
startup in `DefaultResourceLoader.loadCurrentExtensionSet()`, which calls
`packageManager.resolve()` (`dist/core/resource-loader.js:492`). The resolver
reads the `pi` manifest with `readPiManifest()` and returns only the fields
`["extensions","skills","prompts","themes"]` that are arrays of strings
(`dist/core/pi-manifest.js`).

Non‑interactive check (uses the same resolver Pi uses; run from the repo so the
dev dependency resolves):

```bash
node --input-type=module -e '
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const sm = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
const r = await new DefaultPackageManager({ cwd, agentDir, settingsManager: sm }).resolve();
for (const e of r.extensions) if (e.metadata.origin === "package") console.log("ext ", e.path);
for (const e of r.skills)     if (e.metadata.origin === "package") console.log("skill", e.path);
'
```

Verified output (with the local install above):

```
ext   /Users/andrea/Sites/pi-agent-fabric/extensions/factory.ts
skill /Users/andrea/Sites/pi-agent-fabric/skills/factory/SKILL.md
```

So the `pi.extensions` entry resolves directly, and the `pi.skills` directory
entry is walked recursively to `skills/factory/SKILL.md` (skills are discovered
by locating `SKILL.md`; `docs/skills.md:11,59`).

Interactive checks:

- Start Pi, then use `/factory` (the extension registers the command at
  `extensions/factory.ts:204`, `pi.registerCommand("factory", …)`) and
  `/skill:factory` (`docs/skills.md:45`).
- `pi config` opens the resource TUI, where you can see/enable discovered
  extensions and skills per scope (`docs/packages.md:121`; `dist/cli/config-selector.js`).
- `docs/skills.md:89` and `docs/slash-commands.md:49,60` both name `/reload`
  as the way to pick up changed resources, and Pi's `--verbose` shows verbose
  interactive startup information (`docs/cli.md`).

#### Iterating after install

- **After editing `extensions/**` or `skills/**`, re‑installing is unnecessary**
  (local install references the path). Run `/reload` in an active session, or
  restart Pi. `/reload` reloads "keybindings, extensions, skills, templates,
  themes, and context files" (`docs/slash-commands.md:49`), and the loader's
  `reload()` re‑reads settings and re‑resolves packages
  (`dist/core/resource-loader.js:352-369`), so it also picks up a newly installed
  package. [Source‑confirmed; the newly‑installed‑package behaviour is inferred
  from `reload()` calling `packageManager.resolve()`, not separately documented.]
- **There is no watch/hot‑reload mode.** Iteration is `/reload` or a full restart.
  `moduleCache: false` in `loadExtensionModule` (loader.js) means a reload gets a
  fresh module rather than a cached factory.

#### Gotchas

- **Node version.** The repo's own tests require Node ≥24 for native type
  stripping (verified with v24.5.0; `nodejs.org/api/typescript.html`). The Pi
  runtime, however, transforms extension TypeScript through jiti/Babel, so a Pi
  user does not need Node's type stripping for the extension to load. `engines`
  is advisory only unless a consumer sets npm's `engine-strict`
  (`npm/docs/content/configuring-npm/package-json.md:1046`).
- **Peer dependency.** The extension's only import from the host is
  `import type { ExtensionAPI, ExtensionCommandContext } from
  "@earendil-works/pi-coding-agent"` (`extensions/factory.ts:24`) — a type‑only
  import, erased at runtime. `package.json` declares it as an **optional** peer
  (`"*"`), and Pi's managed npm installs deliberately disable peer resolution
  (`getNpmInstallArgs`: `npm install … --prefix … --legacy-peer-deps`,
  `dist/core/package-manager.js:1505-1528`, with the comment that host `@earendil-works/pi-*`
  peers are resolved through loader aliases instead). Practically: never bundle or
  install the host package; consumers get it from their Pi.
- **Where npm/git installs go.** `getNpmInstallRoot` uses `<agentDir>/npm` for
  user scope and `<cwd>/.pi/npm` for project scope, and seeds it with a private
  `package.json` named `pi-extensions` plus a `.gitignore`
  (`dist/core/package-manager.js:1708-1741`). Local installs touch none of this.
- **Project scope needs trust.** `pi install -l …` and reading `.pi/settings.json`
  are gated on project trust (`docs/packages.md:19,21`; `--approve`/`--no-approve`
  in `pi --help`). Personal (user‑scope) installs are not.
- **`package.json#files` is irrelevant to local installs** (nothing is copied),
  but it is exactly what determines the npm tarball — see below.

---

## Publishing to npm

Target package: `@arest/pi-agent-fabric-factory@0.1.0`, currently `"private": true`.
Primary sources: the npm CLI docs shipped with npm 11.5.1
(`/opt/homebrew/lib/node_modules/npm/docs/content/…`, canonical URLs under
`https://docs.npmjs.com/…`) and, for the Pi side, Pi's own docs and the CLI source.

### `"private": true`

- `package.json`'s `private` field: "If you set `private: true` in your
  package.json, then npm will refuse to publish it."
  (`configuring-npm/package-json.md:1172`, https://docs.npmjs.com/cli/v11/configuring-npm/package-json#private).
- The enforcement lives in `libnpmpublish/lib/publish.js:14-20` and throws
  `EPRIVATE`. It is **not** executed by `--dry-run`: `lib/commands/publish.js:187`
  calls `libpub(…)` only `if (!dryRun)`.
- **Verified gotcha:** `npm publish --dry-run` with `"private": true` exits **0**
  (tested both in this repo and on a minimal private package). So a passing
  `--dry-run` does *not* mean the package is publishable. You must remove
  `"private": true` (or set it to `false`) for the real publish.
- `npm pack` / `npm pack --dry-run` also work fine while `private` is `true`
  (verified; packing is not publishing).

### Scoped packages and `--access public`

- "Scoped packages are not public by default. You will need to specify
  `--access public` with the initial `npm publish` command. … You do not need to
  do this when publishing new versions of an existing scoped package."
  (`using-npm/scope.md`, https://docs.npmjs.com/cli/v11/using-npm/scope).
- npm's own `access` config defaults to `null` here (`npm config get access` →
  `null`), and the publish command prints the access level; a new scoped package
  therefore defaults to restricted unless you pass `--access public`.
- You can declare it once instead of on every command:
  `publishConfig` is "a set of config values that will be used at publish-time …
  handy if you want to set the tag, registry or access"
  (`configuring-npm/package-json.md:1183`, https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig).
  Recommended addition to `package.json` for this package:

  ```json
  "publishConfig": { "access": "public" }
  ```

  With that, `npm publish` alone publishes public; you can still override per
  command with `--access restricted`.

### `files` vs `.npmignore`

- Both mechanisms exist; the `files` array is an allowlist, `.npmignore` a
  denylist. "If there is a `files` list in `package.json`, then only the files
  specified will be included … If there is a `.gitignore` or `.npmignore` file,
  then ignored files … will be excluded. If *both* files exist, then the
  `.gitignore` is ignored, and only the `.npmignore` is used."
  (`commands/npm-publish.md`; `configuring-npm/package-json.md:277`).
- A root `.npmignore` does **not** override a root `files` allowlist; in
  subdirectories it does (`configuring-npm/package-json.md:277`).
- Some files are always included (`package.json`, `README*`, `LICENSE*`, `main`,
  `bin`) and some always excluded (`node_modules`, `package-lock.json`,
  `.npmrc`, `.git`, `*.tgz` etc.) unless explicitly re‑included
  (`configuring-npm/package-json.md:277`; `using-npm/developers.md:144-145`).
- This repo already uses a `files` allowlist
  (`["extensions","factory","skills","src","README.md"]`) and has **no**
  `.npmignore` (verified). `npm pack --dry-run --json` reports the resulting
  tarball: **35 entries**, unpacked size 188,553 bytes, shasum
  `4a2f0d38cfad2a287d531df71902d4dae25074d3`. Contents are `README.md`,
  `package.json`, `extensions/factory.ts`, `factory/dashboard.html`,
  `skills/factory/**` (SKILL.md + 3 references), and all of `src/**`. Note that
  `package-lock.json` is excluded (always excluded), and that the allowlist must
  keep `src/` — the extension's relative imports (`../src/…`) would break without it.
- Recommendation: keep the allowlist. It is more maintainable than a `.npmignore`
  for a package this size, and it is what npm documents as the alternative when
  `.npmignore` becomes "a maintenance headache" (`using-npm/developers.md:144-145`).

### Build / prepublish scripts

There is no build output: `tsconfig.json` is `noEmit: true`, the extension is
loaded as TypeScript by jiti, and the tests run via Node type stripping. So
`prepare`, `prepublishOnly`, `prepack` and `postpack` are **not required** for the
package to work. Lifecycle facts, if you want them
(`using-npm/scripts.md:44-71,154-160`):

- `prepare` runs before pack/publish **and on local `npm install`**;
- `prepack` runs before every tarball is packed (`npm pack`, `npm publish`,
  git installs);
- `prepublishOnly` runs **only on `npm publish`**, before pack.

A reasonable optional addition is a last‑gated test run:

```json
"scripts": { "prepublishOnly": "npm run check" }
```

`npm run check` = `tsc --noEmit && node --test`, both of which pass today
(verified). Skip `prepare` for this package: it would re‑run on every consumer‑side
`npm install` for no benefit, since nothing is generated.

### Version bump and git tag

- Use `npm version`, which "bump[s] the version and write[s] the new data back to
  `package.json`, `package-lock.json`, and, if present, `npm-shrinkwrap.json`"
  and, in a git repo, "will also create a version commit and tag"
  (`commands/npm-version.md`, https://docs.npmjs.com/cli/v11/commands/npm-version).
- It "will fail if the working directory is not clean, unless the `-f`/`--force`
  flag is set" (same page). Whether a tag is created is controlled by the
  `git-tag-version` config (default `true`); disable with
  `npm --no-git-tag-version version …`.
- Suggested flow:

  ```bash
  git status                       # must be clean
  npm version patch -m "Release %s"   # or minor / major / explicit x.y.z
  npm publish                         # publishConfig.access === public
  git push --follow-tags              # push the version commit and its tag
  ```

  `npm version` creates the tag; `npm publish` does not.

### `npm pack --dry-run` and `npm publish --dry-run`

- `npm pack --dry-run` prints exactly what would be packed and writes nothing;
  `npm pack` (without `--dry-run`) writes `@arest/pi-agent-fabric-factory-0.1.0.tgz`
  into the cwd, so prefer `--pack-destination /tmp/...` to avoid dirtying the repo.
  `commands/npm-pack.md`: `pack` "copy[s] the tarball to the current working
  directory as `<name>-<version>.tgz`".
- `npm publish --dry-run` reports the tag/access it would use and skips the
  upload (`commands/npm-publish.md`, `dry-run`; `lib/commands/publish.js:187`).
  **Caveat:** it skips `EPRIVATE` *and* downgrades the "not logged in" hard error
  to a warning (`lib/commands/publish.js:158-163`) — so treat it as a packing
  check, not an auth or publishability check.
- Before publishing, confirm you are authenticated: `npm whoami`
  (`npm login` docs: https://docs.npmjs.com/cli/v11/commands/npm-login). Not
  verified here to avoid touching credentials.

### `npm login`, auth, 2FA

- `npm login` verifies the user and saves credentials to `.npmrc`; the default
  `auth-type` is `web` (browser flow), and the CLI generates a legacy
  `publish`-type token (`commands/npm-login.md`).
- Two‑factor auth is configured at the account level:
  `npm profile enable-2fa [auth-and-writes|auth-only]` (default
  `auth-and-writes`), where `auth-and-writes` additionally "requires one when
  publishing a module, setting the `latest` dist-tag, or changing access"
  (`commands/npm-profile.md`). With `auth-and-writes`, publish needs an OTP:
  `npm publish --otp <code>`, or npm prompts for one on a registry challenge
  (`commands/npm-publish.md`, `otp`).
- For automation, use an **automation token** rather than `npm login`; the CLI
  cannot generate automation tokens (`commands/npm-token.md`: "Currently, the cli
  can not generate automation tokens"), they are created on the npm website
  (https://docs.npmjs.com/creating-and-viewing-access-tokens). Automation tokens
  bypass the OTP prompt. [The "bypass OTP" behaviour is documented on the website
  page above, which I did not machine‑verify — **[partially unverified]**.]

### How `peerDependencies` affect consumers

- `peerDependencies` expresses host compatibility, and since npm v7 peers "are
  installed by default" — but optional peers are not
  (`configuring-npm/package-json.md:823-825,839-843`, https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependencies).
- This package's peer is both optional and, for Pi‑managed installs, irrelevant:
  Pi installs packages with peer resolution disabled
  (`--legacy-peer-deps` for npm; `dist/core/package-manager.js:1505-1528`) and
  resolves `@earendil-works/pi-coding-agent` from the running Pi via jiti aliases
  (`dist/core/extensions/loader.js`). So publishing should not cause consumers to
  install the host package. Keep the peer range broad: npm docs warn to keep it
  "as broad as possible" (`configuring-npm/package-json.md:823-830`), which `"*"`
  satisfies.
- Note the asymmetry: `peerDependencies` is advisory for the *runtime* install,
  but exact `dependencies` would be installed into the Pi npm directory. This
  package currently has no runtime `dependencies`, which is the right shape.

### Prereleases and dist‑tags

- Publishing sets `latest` to the published version **unless** `--tag` is used:
  "Publishing a package sets the `latest` tag to the published version unless the
  `--tag` option is used. For example, `npm publish --tag=beta`"
  (`commands/npm-dist-tag.md`, https://docs.npmjs.com/cli/v11/commands/npm-dist-tag).
  There is no automatic "prerelease → non‑latest" behaviour.
- Hence for a prerelease, publish with a tag:

  ```bash
  npm version 0.1.1-beta.0      # explicit semver (or: npm version prerelease --preid=beta)
  npm publish --tag beta
  ```

  `--preid` sets the identifier (e.g. `beta` in `0.1.1-beta.0`); valid `npm
  version` arguments are documented in `commands/npm-version.md`.
- `publishConfig.tag` exists but would pin *every* publish to that tag; prefer
  the command‑line `--tag beta` so a later stable `npm publish` still becomes
  `latest`.
- The registry refuses a version that already exists: "The publish will fail if
  the package name and version combination already exists" (`commands/npm-publish.md`).
  It also refuses to implicitly move `latest` backwards: if a higher version is
  already published, publishing a lower one without `--tag` errors with "Cannot
  implicitly apply the 'latest' tag … You must specify a tag using --tag"
  (`/opt/homebrew/lib/node_modules/npm/lib/commands/publish.js:175`). Both are
  per‑version/per‑tag comparisons, so prereleases are fine on their own tag.

### Does a Pi package need anything beyond a normal npm publish?

No. The npm source install path is an ordinary `npm install <spec> --prefix
<pi-npm-dir> --legacy-peer-deps` into the Pi npm directory
(`dist/core/package-manager.js:1505-1545`); Pi then reads the installed
`package.json`, applies the `pi` manifest or the conventional `extensions/`,
`skills/`, `prompts/`, `themes/` directories, and loads the resources
(`docs/packages.md:5,36,44-48`). Verified end‑to‑end by installing the unpacked
`npm pack` tarball (see the local‑testing section): both the extension and the
recursive skill resolve from the packed file set.

Concretely, for `pi install npm:@arest/pi-agent-fabric-factory` to work the
published package must:

1. exist on the registry and not be `private`;
2. ship the extension entry (`extensions/factory.ts`) and everything it imports
   (`src/**`, i.e. keep `src` in `files`);
3. ship the skill (`skills/factory/SKILL.md` + references), which the `pi` manifest
   points at via `skills: ["./skills"]`;
4. declare `@earendil-works/pi-coding-agent` as a peer (done).

The `pi` manifest is read from the **installed** `package.json`
(`readPiManifest`, `dist/core/pi-manifest.js`), so the published `package.json`
must still contain `pi` — it does (it is always included in the tarball).

Publishing a prerelease is also installable: `pi install` splits the spec at `@`
and passes the tail to npm, so `pi install npm:@arest/pi-agent-fabric-factory@beta`
resolves the `beta` dist‑tag (`parseNpmSpec`, `dist/core/package-manager.js:1434-1444`).
[The tag‑as‑version string is passed through to npm; Pi's own installed‑version
range check is simply skipped when the tail is not a semver range
(`getNpmVersionRange`, same file) — behaviour read from source, not exercised
against a live registry.]

### Subsequent updates, and unpublish limits

- **Update flow (idempotent):** bump the version (new commit + tag), `npm publish`,
  push tags. Every publish must be a *new* version — you cannot republish an
  existing `name@version` (`commands/npm-publish.md`; `policies/unpublish.mdx:8`).
- **Immutable versions:** "Once a package is published with a given name and
  version, that specific name and version combination can never be used again,
  even if it is removed with `npm unpublish`" (`commands/npm-publish.md`).
- **Unpublish policy** (https://docs.npmjs.com/policies/unpublish; markdown source
  `https://raw.githubusercontent.com/npm/documentation/main/content/policies/unpublish.mdx`):
  - **< 72 hours** after first publish: you may unpublish as long as no other
    public‑registry package depends on it (`policies/unpublish.mdx:12-14`);
  - **> 72 hours**: unpublish is allowed only if *all* of these hold — no
    dependents, < 300 downloads in the last week, and a single owner/maintainer
    (`policies/unpublish.mdx:16-21`);
  - unpublishing cannot be undone, and once `name@version` is used it can never
    be reused (`policies/unpublish.mdx:8,32-33`);
  - if you unpublish **all** versions, "you may not publish any new versions of
    that package until 24 hours have passed" (`policies/unpublish.mdx:34`;
    also `commands/npm-unpublish.md`);
  - `npm unpublish <pkg> --force` removes all versions only when they are all
    eligible (`policies/unpublish.mdx:26-28`; `commands/npm-unpublish.md`, `force`);
  - if the package is not eligible, npm recommends `npm deprecate` instead
    (`policies/unpublish.mdx:40-44`).
- Because of that, the safe default is: never unpublish; ship a fix as a new
  version (and, if needed, `npm deprecate`).

---

## Open questions / unverified

1. **`npm publish --dry-run` vs real publish.** Verified that `--dry-run` exits 0
   even with `private: true`, does not surface `EPRIVATE`, and downgrades the
   missing‑login error to a warning. The *real* publish refusing a private package
   is documented (`package-json.md:1172`) and enforced in
   `libnpmpublish/lib/publish.js:14-20`, but I did not run a real publish, so the
   end‑to‑end refusal on this exact package is **[unverified by execution]**.
2. **`npm login` / 2FA.** Not exercised (credential‑touching). Behaviour is taken
   from `commands/npm-login.md` and `commands/npm-profile.md`. The claim that an
   automation token bypasses the `auth-and-writes` OTP prompt comes from the npm
   website token docs, not from a page I could extract text from — **[partially
   unverified]**.
3. **npm 11.5.1 doc content vs the live site.** I verified against the docs
   shipped inside npm 11.5.1 (`/opt/homebrew/lib/node_modules/npm/docs/content/…`)
   and cite the corresponding `docs.npmjs.com/cli/v11/…` URLs. The unpublish
   policy was fetched from the npm documentation repo's markdown source. If
   docs.npmjs.com has since changed, the site is authoritative.
4. **Pi `/reload` picking up a brand‑new package.** `/reload` is documented to
   reload extensions/skills/etc. (`docs/slash-commands.md:49`) and its
   implementation re‑resolves packages (`dist/core/resource-loader.js:352-369`),
   but I did not drive an interactive session to watch a newly installed package
   appear after `/reload` alone. Restarting Pi is always sufficient.
5. **Pi `pi install npm:@…@<tag>` for a prerelease.** Derived from source
   (`parseNpmSpec` + `getNpmVersionRange`), not exercised against a published
   registry.
6. **`engines.node: ">=24"` for consumers.** Advisory per npm docs
   (`package-json.md:1046`); Pi's runtime does not require Node's type stripping
   for the extension (jiti transforms it), but I did not test the package on a
   Pi install running an older Node.
