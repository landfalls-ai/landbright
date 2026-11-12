# Development

## Setup

Node 22.12 or later, pnpm 10, and OrbStack (Docker).

```bash
pnpm install
pnpm dev:up        # Postgres, Valkey, Mailpit, OpenBao (compose project landbright-infra), waits until healthy
pnpm serve         # idp, control and the console, rebuilding on change
```

Open <http://127.0.0.1:4400>. No `.env` is needed: every setting defaults to its development value. To change one,
copy `.env.example` to `.env` (app settings) or `deploy/.env.example` to `deploy/.env` (container ports).

`pnpm dev:down` stops the infrastructure and keeps its volumes. OpenBao runs in dev mode and forgets everything when it
restarts.

## Ports

Everything binds to 127.0.0.1. The infrastructure sits in the 57xxx band so it never collides with Landflow (51xxx,
55xxx, 56xxx, 58xxx) on the same Docker engine.

| Port | What |
|---|---|
| 4400 | Console (Vite); `/api` is proxied to control |
| 4401 | Control API; `/healthz`, `/api/health`, `/api/docs`, `/api/openapi.json` |
| 4402 | Identity plane (idp); `/healthz` |
| 57432 | Postgres 16: `landbright` (app), `landbright_test` (integration tests); user `landbright`, password `landbright-dev-only` |
| 57379 | Valkey 8 |
| 57025 / 57825 | Mailpit SMTP / web UI |
| 57200 | OpenBao (dev mode), root token `landbright-dev-only` |

## Commands

| Command | What it does |
|---|---|
| `pnpm verify` | Type check, lint, test and build every project. A change is done when this is green. |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` | Each step on its own (Nx; cached). |
| `pnpm test:integration` | Tests against the compose stack (`pnpm dev:up` first). |
| `pnpm --filter <project> test` | One project: `@landbright/control`, `@landbright/idp`, `@landbright/platform`, `@landbright/contracts`, `@landbright/console`, `@land/tokens`. |
| `pnpm format` | Prettier. |

## Tests

- Tests live in each project's `test/` folder and run with Vitest.
- Nest projects compile tests with SWC (`vitest.config.mts`) because Nest needs decorator metadata. Workspace libraries
  resolve to their source, so a test never needs a build first.
- Control's route tests fake Postgres and Valkey in memory and serve the identity plane, OpenBao and Mailpit from one
  local HTTP server. `health.integration.test.ts` runs the same code against the real stack.
- Tests against real services skip unless `LANDBRIGHT_INTEGRATION` names them: `infra`, or `all`.
- The console's tests render the real router in jsdom with `fetch` stubbed (`apps/console/test/render.tsx`).
- `@land/tokens` checks its copy against Landflow's `globals.css` when the Landflow checkout sits next to this repo
  (`LANDFLOW_DIR` points elsewhere).

## Tracing

Tracing is off until an exporter is set. `OTEL_TRACES_EXPORTER=console` prints spans to the service's stdout;
`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` sends them over OTLP/HTTP to a local collector. The services are
`landbright-idp` and `landbright-control`; HTTP, Express, Nest, pg and ioredis are instrumented
(`libs/platform/src/telemetry`).

## Where code goes

- A new route: a controller in `apps/control/src/<area>/`, its request and response schemas in `libs/contracts`,
  `@ZodResponse` on the handler, and a row in `docs/reference/api.md`.
- A new setting: `ConfigSchema` in `libs/platform/src/config.ts` with its development default, the same line in
  `.env.example`, and a row in `docs/reference/configuration.md`.
- A new console page: a route in `apps/console/src/routes/`, wired in `src/router.tsx`, and in `src/nav.ts` if it is in
  the sidebar.
