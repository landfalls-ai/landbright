# Architecture

Three processes and four pieces of infrastructure, all on this machine.

```
 browser ──▶ console (Vite, :4400) ── /api ──▶ control (NestJS, :4401) ──▶ Postgres · Valkey · OpenBao · Mailpit
                                                     │
                                                     └── /healthz ──▶ idp (NestJS, :4402)
 relying parties (Landflow, Landfall; wave 1) ───────────────────────▶ idp: OIDC, sign-in pages, JWKS
```

| Process | Owns | Now (wave 0) | Next |
|---|---|---|---|
| **idp** (`apps/idp`) | The protocol plane: OIDC/OAuth 2.1, sign-in pages, sessions, JWKS, token exchange. Small and hardened, separately deployable, no console code. | `/healthz` | Wave 1: `oidc-provider` mounted, passkeys, password + TOTP |
| **control** (`apps/control`) | The console API and the system of record: directory, catalog, requests, grants, the ledger, sync, webhooks, the sweeper. | `/healthz`, `/api/health`, OpenAPI | Wave 1: tenants, people, agents, groups, applications, audit |
| **console** (`apps/console`) | The UI, in Landflow's shell and tokens. Talks only to control. | Home, Health, a page for each later section | Wave 1: Directory and Applications pages, sign-in |

## What every service shares (`libs/platform`)

- `startService`: Helmet security headers, the global `DefaultDenyGuard`, graceful shutdown, a listener on 127.0.0.1.
- `DefaultDenyGuard` + `@Public()`: a route is closed unless marked public or a principal is on the request (wave 1
  sets it from a session or bearer token).
- `loadConfig` / `loadWorkspaceEnv`: zod-validated settings with development defaults; the workspace `.env` if any.
- Health probes (`probe`, `probePostgres`, `probeValkey`, `probeHttp`), each bounded by a 2 s timeout, and
  `livenessController`.
- `startTelemetry` (`@landbright/platform/telemetry`): OpenTelemetry, imported first in each `main.ts`.

## Contracts (`libs/contracts`)

zod schemas are the source of truth for every wire shape. Control validates requests and serializes responses against
them (`nestjs-zod`) and generates `/api/openapi.json` from them; the console parses responses with the same schemas.
Built as ESM (console) and CommonJS (services).

## Design tokens (`libs/tokens`, `@land/tokens`)

Landflow's token blocks, verbatim, plus a Tailwind 4 `@theme` and base layer. A test fails when they drift from
Landflow's `globals.css`.

## Code map

```
apps/idp/src/            main.ts · instrument.ts · app.module.ts
apps/control/src/        main.ts · configure.ts (prefix, OpenAPI) · app.module.ts · infra/ · health/
apps/console/src/        main.tsx · router.tsx · nav.ts · waves.ts · routes/ · components/{shell,ui}/ · lib/
libs/platform/src/       config.ts · bootstrap.ts · auth/ · health/ · telemetry/
libs/contracts/src/      health.ts
libs/tokens/src/         tokens.css · theme.css
deploy/                  compose.infra.yml · infra/postgres/init.sql
```
