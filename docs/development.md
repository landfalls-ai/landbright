# Development

## Setup

Node 22.12 or later, pnpm 10, and OrbStack (Docker).

```bash
pnpm install
pnpm dev:up        # Postgres, Valkey, Mailpit, OpenBao (compose project landbright-infra), waits until healthy
pnpm db:setup      # migrations, then the tenant, Landbright Admins, the first administrator, the console's client
pnpm serve         # idp, control and the console, rebuilding on change
```

Open <http://127.0.0.1:4400> (use `127.0.0.1`, not `localhost`: sign-in returns to the console URL and the session
cookie belongs to that host). Sign in as `admin@landbright.test` with the bootstrap password from `.env.example`. Mail
(invites) lands in Mailpit at <http://127.0.0.1:57825>. No `.env` is needed: every setting defaults to its development
value. To change one,
copy `.env.example` to `.env` (app settings) or `deploy/.env.example` to `deploy/.env` (container ports).

`pnpm dev:down` stops the infrastructure and keeps its volumes. OpenBao runs in dev mode and forgets everything when it
restarts.

## Ports

Everything binds to 127.0.0.1. The infrastructure sits in the 57xxx band so it never collides with Landflow (51xxx,
55xxx, 56xxx, 58xxx) on the same Docker engine.

| Port | What |
|---|---|
| 4400 | Console (Vite); `/api` is proxied to control |
| 4401 | Control API; `/healthz`, `/api/*`, `/api/docs`, `/api/openapi.json` |
| 4402 | Identity plane (idp), at `http://localhost:4402` (passkeys need a domain; it listens on 127.0.0.1); `/healthz`, the issuer at `/oidc`, sign-in and invite pages |
| 57432 | Postgres 16: `landbright` (app), `landbright_test` (integration tests); owner `landbright` / `landbright-dev-only`, app role `landbright_app` / `landbright-app-dev-only` |
| 57379 | Valkey 8 |
| 57025 / 57825 | Mailpit SMTP / web UI |
| 57200 | OpenBao (dev mode), root token `landbright-dev-only` |

## Commands

| Command | What it does |
|---|---|
| `pnpm verify` | Type check, lint, test and build every project. A change is done when this is green. |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` | Each step on its own (Nx; cached). |
| `pnpm test:integration` | Tests against the compose stack (`pnpm dev:up` first): row-level security and the audit chain (`db`), control's health (`infra`), and end to end (`e2e`). |
| `pnpm test:browser` | Real Chromium (Playwright) against the built idp, control and console: the console's pages and the sign-in pages, passkeys through Chrome's virtual authenticator. Needs the compose stack too. |
| `pnpm screenshots` | The same story, writing every screen to `docs/screenshots/` ([screens.md](screens.md)). |
| `pnpm conformance` | The OpenID Foundation conformance suite (OIDC basic plan) against a dedicated identity plane behind a TLS proxy, in Docker (compose project `landbright-conformance`); about two minutes. `--keep` leaves the suite running. Needs the compose stack and `pnpm build`. Results: [spec 002 plan](../specs/002-identity-core/plan.md#conformance-suite-t012b). |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:setup` | Apply migrations (and the app role's development password); run the bootstrap; both. Idempotent. |
| `pnpm --filter @landbright/persistence migrate:dev` | Create a migration after changing `prisma/schema.prisma`. Never reset the database; add a migration. |
| `pnpm --filter <project> test` | One project: `@landbright/control`, `@landbright/idp`, `@landbright/persistence`, `@landbright/platform`, `@landbright/contracts`, `@landbright/console`, `@land/tokens`. |
| `pnpm format` | Prettier. |

## Tests

- Tests live in each project's `test/` folder and run with Vitest.
- Nest projects compile tests with SWC (`vitest.config.mts`) because Nest needs decorator metadata. Workspace libraries
  resolve to their source, so a test never needs a build first.
- Control's route tests fake Postgres, Valkey and the session in memory and serve the identity plane, OpenBao and Mailpit from one
  local HTTP server. `health.integration.test.ts` runs the same code against the real stack.
- Tests against real services skip unless `LANDBRIGHT_INTEGRATION` names them: `infra`, `db`, `e2e`, `browser`, or
  `all`.
- Database tests use `landbright_test`, migrated on first use. Each end-to-end run creates its own tenant there
  (`e2e-<time>`), so runs never see each other.
- `e2e/` starts the **built** idp and control as processes on free ports against `landbright_test`, Valkey and
  Mailpit, then drives them like a browser (`browser.ts`, a cookie jar per host) and like Landflow (`landflow-rp.ts`).
  `pnpm test:integration` builds first; run alone, `pnpm build` then `pnpm --filter @landbright/e2e test:integration`.
- `e2e/browser/` is Playwright 1.62 (Chromium from the shared `~/Library/Caches/ms-playwright`; `npx playwright
  install chromium` if it is missing). `startStack({ console: true })` adds the built console under `vite preview`, so
  sign-in returns to it as in development. A Landflow-shaped app on a free port finishes each sign-in like Landflow
  (`landflow-rp.ts`) and shows the claims. Passkeys use Chrome's virtual authenticator (CDP `WebAuthn`), so the
  sign-in pages' own script runs the ceremony. One story in order, one worker; traces of failures land in
  `e2e/test-results/`.
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
