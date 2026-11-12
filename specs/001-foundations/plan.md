# Plan 001: Foundations

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-12

## Technical context

pnpm 10.28 workspaces with Nx 22 inferring targets from each `package.json` (`build`, `typecheck`, `test`, `serve`;
`serve` is continuous and waits for `^build`). Node 22, TypeScript 5.9.

| Project | What | Build |
|---|---|---|
| `libs/contracts` (`@landbright/contracts`) | zod 4 schemas: `HealthReport`, `ComponentHealth`, `Liveness` | tsup, ESM + CJS + types |
| `libs/platform` (`@landbright/platform`) | `loadConfig` / `loadWorkspaceEnv`, `startService`, `DefaultDenyGuard` + `@Public()`, health probes, `livenessController`, `startTelemetry` | tsc, CommonJS |
| `libs/tokens` (`@land/tokens`) | Landflow's token blocks verbatim, a Tailwind 4 `@theme`, the base layer | CSS, no build |
| `apps/idp` | NestJS 11; `GET /healthz` | `nest build` |
| `apps/control` | NestJS 11; `GET /healthz`, `GET /api/health`, `/api/openapi.json`, `/api/docs` | `nest build` |
| `apps/console` | React 19, Vite 8, Tailwind 4, react-router 7, TanStack Query 5 | `vite build` |

Services are CommonJS (Landfall's setting), which keeps OpenTelemetry's require-hook instrumentation simple. Node
22.12+ can `require()` ESM-only packages such as `oidc-provider`, so wave 1 doesn't force a module change.

Tests: Vitest everywhere. Nest tests compile with SWC (`unplugin-swc`) for decorator metadata and resolve workspace
libraries to their source. The console tests render the real router in jsdom with `fetch` stubbed.

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt plumbing, build the core | PASS | Adopted: NestJS, `@nestjs/swagger` + `nestjs-zod`, OpenTelemetry SDK, OpenBao, Valkey, Mailpit. Nothing protocol-level is built. |
| II. Default deny | PASS | `libs/platform/src/auth/default-deny.guard.ts` is global in `startService`; the only `@Public()` routes are `/healthz` and `/api/health`, each with its reason. No tables yet. |
| III. Accountable human | N/A | No identities yet. |
| IV. Policy or a person approves | N/A | No requests yet. |
| V. Event-sourced ledger | N/A | No state yet. |
| VI. Standards on the wire | PASS | OpenAPI 3.1; W3C trace context via OpenTelemetry. |
| VII. Stateless, N-up safe | PASS | The services hold only connection pools; no background work. |
| VIII. Spec-driven, test-backed | PASS | This spec; contracts in `libs/contracts`; unit, route and integration tests (`apps/control/test/health.integration.test.ts`). |
| IX. Local only | PASS | `landbright-infra` compose project bound to 127.0.0.1 on 57xxx ports; services listen on 127.0.0.1; dev credentials only. |

**Integration Definition of Done**: not applicable (no external integration).

## Decisions

- **Ports**: the 57xxx band for infrastructure (Landflow uses 51xxx, 55xxx, 56xxx and 58xxx) and 4400–4402 for the
  three processes.
- **`/api/health` is public in wave 0**, so the console can show it before sign-in exists. It reveals local addresses
  and versions, never credentials. Wave 1 restricts it to administrators (docs/limitations.md).
- **Liveness vs health**: `/healthz` says only that the process serves; control's `/api/health` probes dependencies.
  An orchestrator restarts on the first, never on the second.
- **Valkey without an offline queue**: commands fail at once while disconnected, so the probe reports
  `not connected (reconnecting)` instead of hanging until its timeout.
