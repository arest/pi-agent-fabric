# Unauthenticated Attack Surface

Reachable by an anonymous attacker — no valid session, token, or API key.

**Coverage**: 0 HTTP/API entry points | 0 by-design public | 0 missing-guard / middleware-gap
**Auth model**: none — this package has no network-facing application server. `/factory` is a local Pi host command whose access control is delegated to the Pi host/operator session, not an HTTP token or middleware.
**Coverage gaps**: deployment-specific static servers, Pi host command authorization, project-local resource loading, and any wrapper that exposes the dashboard or `factory/` directory are unresolved.

This repository implements a local extension, not an inbound web service. An anonymous remote attacker cannot reach a factory route from the source tree alone. A local user who can drive the same Pi session is not anonymous in the host's security model, but the package itself performs no independent identity or authorization check.

## Pre-Auth HTTP / API Routes

No HTTP/API routes were found. No middleware, proxy, route matcher, auth header, tenant selector, method override, or cache-key implementation exists in this repository.

## Other Unauthenticated Entry Points

| Kind | Entry point (file:line) | Why pre-auth | Notes |
|------|-------------------------|--------------|-------|
| Local Pi command surface | `extensions/factory.ts:207` (`pi.registerCommand("factory", ...)`) | by-design — local command access is delegated to the Pi host/operator session | `/factory` feature text, job IDs, and notes can reach filesystem/state transitions. The package has no independent authz guard. |
| Static / file server | `factory/dashboard.html:138` and relative `board.json`/`jobs/...` links | by-design when a consumer chooses to serve the static directory publicly; no app auth exists | Conditional deployment surface. Dashboard is read-only and client-side escaped, but exposed files may disclose board, artifacts, notes, source paths, and PR metadata. Server-side access control is required if the directory is not private. |
| Project-local extension/resource loader | host-controlled; package manifest `package.json:22-29` and `extensions/factory.ts:1` | middleware-gap equivalent at the host boundary — trust/loading is determined before this package runs | Not a network route. A hostile checkout may influence host loading depending on Pi configuration/version; L1 includes related host advisories. |

**Model conclusion:** there are no anonymous network sinks to elevate in this repository. The highest-risk reachable surfaces are local host command access, repository-controlled process execution, filesystem state, and any deployment that serves the static dashboard/artifacts without authorization.
