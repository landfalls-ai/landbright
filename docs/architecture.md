# Architecture

Three processes and four pieces of infrastructure, all on this machine.

```
 browser ──▶ console (Vite, :4400) ── /api ──▶ control (NestJS, :4401) ──▶ Postgres · Valkey · Mailpit
    │                                              │  OIDC client of the idp (console sign-in)
    │                                              ▼
    └──── sign-in pages, invite links ──────▶ idp (NestJS + oidc-provider, :4402) ──▶ Postgres · Valkey
 relying parties (Landflow, Landfall) ───────▶ idp: /oidc (discovery, auth, token, JWKS, userinfo, logout)
 Landflow flows ──── client credentials ────▶ control /api/v1 (machine API)
 control ── signed events (JWT, JWKS) ──────▶ Landflow Webhook triggers
```

| Process | Owns | Now (wave 1) | Next |
|---|---|---|---|
| **idp** (`apps/idp`) | The protocol plane: OIDC/OAuth 2.1, sign-in pages, sessions, JWKS, later token exchange. Small and hardened, no console code. | `oidc-provider` at `/oidc` with a Postgres adapter, rebuilt when the signing keys change; password, authenticator-app and passkey sign-in with lockout; invite pages; sealed signing keys with rotation | Token exchange (wave 5) |
| **control** (`apps/control`) | The console API and the system of record: directory, catalog, requests, grants, the ledger, sync, webhooks, the sweeper. | Console sign-in (backend-for-frontend), people, agents, groups, applications, audit, invite mail, health; access (bundles, requests, decisions, grants), events out, the machine API `/api/v1`, and a worker (sweeper, deliveries, wake-ups) under a Valkey lock | SCIM out (wave 2) |
| **console** (`apps/console`) | The UI, in Landflow's shell and tokens. Talks only to control. | Sign-in gate; Home, People, Agents, Groups, Applications, Audit log, Health, Settings; Requests and the request page (everyone), Grants, Catalog, Events | Sources (wave 3) |

## Data (`libs/persistence`)

Prisma 6 over Postgres. Tenant tables carry `tenant_id` under forced row-level security; the services connect as
`landbright_app` and run every query in `withTenant` (a transaction with `app.tenant_id` set). `oidc_payload` and
`signing_key` are deployment-wide. The audit log is append-only and hash-chained per tenant. `ensureBootstrap`
(`pnpm db:setup`) creates the tenant, *Landbright Admins*, the first administrator and the console's client.
[directory.md](directory.md) and [sign-in.md](sign-in.md) describe the behaviour.

## What every service shares (`libs/platform`)

- `startService` / `applyServiceDefaults`: Helmet (the idp sets a strict CSP for its pages), the global
  `DefaultDenyGuard`, graceful shutdown, listeners on 127.0.0.1 and [::1] (loopback only).
- `DefaultDenyGuard` + `@Public()`: a route is closed unless marked public or a principal is on the request (control's
  session middleware sets it from `lb_session`).
- `loadConfig` / `loadWorkspaceEnv`, `issuerOf`: zod-validated settings with development defaults.
- `crypto.ts`: HKDF-derived keys, AES-256-GCM sealing, derived client secrets, link tokens.
- `createValkey`; health probes (each bounded by 2 s) and `livenessController`; `startTelemetry`.

## Contracts (`libs/contracts`)

zod schemas are the source of truth for every wire shape: health, directory (people, agents, groups), applications,
audit, session, access, events, and the machine API's scopes. Control validates requests and serializes responses against them (`nestjs-zod`) and generates
`/api/openapi.json`; the console parses responses with the same schemas.

## Design tokens (`libs/tokens`, `@land/tokens`)

Landflow's token blocks, verbatim, plus a Tailwind 4 `@theme` and base layer. The idp's sign-in pages use them too. A
test fails when they drift from Landflow's `globals.css`.

## Code map

```
apps/idp/src/            main.ts · configure.ts (CSP, /oidc mount) · oidc/{provider,provider-ref,adapter,account,
                         agents,token-exchange,ciba} ·
                         interactions/ (sign-in, lockout, required actions) · invite/ · account/ (account page, forgot password, self-session) ·
                         ciba/ (the decision page) · mail/ · pages/ (server-rendered HTML; agent-pages: device, CIBA)
apps/control/src/        main.ts · configure.ts (prefix, origin check, session, service tokens on /api/v1, OpenAPI) ·
                         auth/ (console sign-in) · directory/ (people, agents, groups) · applications/ · audit/ ·
                         access/ (bundles, requests, decisions, grants, sweeper) · events/ (subscriptions, the
                         worker: deliveries and wake-ups) · machine/ (/api/v1, DPoP) · mail/ · health/ ·
                         common/ (principal, key-ring)
apps/console/src/        router.tsx · nav.ts · routes/ · components/{shell,ui,directory,access}/ · lib/api.ts
libs/persistence/        prisma/ (schema, migrations) · src/{tenant,audit,passwords,bootstrap,signing-keys}.ts
libs/platform/src/       config.ts · crypto.ts · valkey.ts · bootstrap.ts · auth/ · health/ · telemetry/
libs/contracts/src/      health · directory · applications · agent-apps · audit · session · access · events · machine-api
e2e/test/                stack.ts (processes) · browser.ts · landflow-rp.ts · authenticator.ts · signin.test.ts ·
                         access.test.ts (access, events and the machine API, with a hook server) ·
                         agents.test.ts (agent applications, token exchange, CIBA, device grant, PAR, DPoP)
e2e/browser/             console.spec.ts (Playwright: the console and sign-in pages in Chromium; the screenshots)
e2e/landflow/            install.ts (installs the Landflow flows and wires both sides)
integrations/landflow/   flows/*.json (the Landflow flows: approval, provisioning, onboarding, inactive people, CIBA)
e2e/conformance/         run.ts (pnpm conformance: the OpenID conformance suite against a dedicated identity plane)
deploy/                  compose.infra.yml · infra/postgres/init.sql · conformance/ (suite, TLS proxy) ·
                         landflow/ (a throwaway Landflow signing in through Landbright) ·
                         keycloak/ (a local Keycloak to study, spec 004)
```
