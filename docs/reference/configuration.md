# Configuration reference

Every variable has a development default (`libs/platform/src/config.ts`), equal to its value in `.env.example`, so a
fresh checkout runs with no `.env`. A `.env` next to `pnpm-workspace.yaml` is loaded at start; variables already in
the environment win. An invalid value stops the process with every bad variable named.

## Services

| Variable | Default | Used by |
|---|---|---|
| `LANDBRIGHT_ENV` | `local` | control: the environment shown in the console; telemetry: `deployment.environment.name` |
| `LANDBRIGHT_CONSOLE_PORT` | `4400` | console (Vite) |
| `LANDBRIGHT_CONTROL_PORT` | `4401` | control; the console's `/api` proxy |
| `LANDBRIGHT_IDP_PORT` | `4402` | idp |
| `LANDBRIGHT_IDP_URL` | `http://localhost:4402` | The identity plane's public URL. The issuer is `<this>/oidc`; invite links point here. Its host is the passkeys' relying-party id, so it must be a domain (`localhost` works over http): with an IP address, passkeys are switched off. |
| `LANDBRIGHT_CONSOLE_URL` | `http://127.0.0.1:4400` | Where console sign-in returns (`/api/auth/callback`), the only origin allowed to write to control, and the console client's redirect (set when `pnpm db:setup` creates it). |
| `LANDBRIGHT_DATABASE_URL` | `postgres://landbright_app:landbright-app-dev-only@127.0.0.1:57432/landbright` | idp, control. The app role, under row-level security. |
| `LANDBRIGHT_DATABASE_ADMIN_URL` | `postgres://landbright:landbright-dev-only@127.0.0.1:57432/landbright` | Migrations and the bootstrap only (a superuser bypasses row-level security). |
| `LANDBRIGHT_TENANT_SLUG` / `_NAME` | `local` / `Local` | The tenant this deployment serves. The services refuse to start until it exists (`pnpm db:setup`). |
| `LANDBRIGHT_ID_TOKEN_TTL_SECONDS` | `3600` | How long an ID token lives. A signing-key rotation keeps the replaced key published at least this long after it stops signing. The end-to-end tests use 15 to rotate twice in one run. |
| `LANDBRIGHT_SECRET_KEY` | a development value | Seals signing keys; derives client secrets and the identity plane's cookie keys. 32+ characters. Changing it ends every session, changes every client secret, and replaces the signing key. |
| `LANDBRIGHT_BOOTSTRAP_ADMIN_EMAIL` | `admin@landbright.test` | The first administrator, created by `pnpm db:setup` if missing. |
| `LANDBRIGHT_BOOTSTRAP_ADMIN_PASSWORD` | `landbright-dev-only` | Their password (12+ characters). Used only when creating them. |
| `LANDBRIGHT_SMTP_URL` | `smtp://127.0.0.1:57025` | control: invite mail (Mailpit). |
| `LANDBRIGHT_MAIL_FROM` | `Landbright <no-reply@landbright.test>` | control: the From of invite mail. |
| `LANDBRIGHT_VALKEY_URL` | `redis://127.0.0.1:57379` | idp (sign-in lockout), control (console sessions) |
| `LANDBRIGHT_OPENBAO_ADDR` | `http://127.0.0.1:57200` | control (health probe) |
| `LANDBRIGHT_OPENBAO_TOKEN` | `landbright-dev-only` | Not used yet (signing keys are in Postgres; docs/limitations.md) |
| `LANDBRIGHT_MAILPIT_URL` | `http://127.0.0.1:57825` | control (health probe); the e2e test reads invites from it |
| `LANDBRIGHT_INTEGRATION` | unset | Tests: comma-separated suites against real services (`infra`, `db`, `e2e`, or `all`) |
| `LANDBRIGHT_TEST_DB_HOST` | `127.0.0.1:57432` | Tests: where `landbright_test` is |

## OpenTelemetry

Tracing is off unless one of the first two is set. The standard `OTEL_*` variables apply.

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Export spans over OTLP/HTTP, e.g. `http://127.0.0.1:4318`. |
| `OTEL_TRACES_EXPORTER` | `console` prints spans to stdout. |
| `OTEL_SERVICE_NAME` | Overrides `landbright-idp` / `landbright-control`. |

## Infrastructure (`deploy/.env`)

`LANDBRIGHT_BIND_ADDR` (`127.0.0.1`), `LANDBRIGHT_POSTGRES_PORT` (`57432`), `LANDBRIGHT_POSTGRES_USER` /
`_PASSWORD` / `_DB` (`landbright` / `landbright-dev-only` / `landbright`), `LANDBRIGHT_VALKEY_PORT` (`57379`),
`LANDBRIGHT_SMTP_PORT` (`57025`), `LANDBRIGHT_MAIL_UI_PORT` (`57825`), `LANDBRIGHT_OPENBAO_PORT` (`57200`),
`LANDBRIGHT_OPENBAO_TOKEN` (`landbright-dev-only`). Changing a port here means changing the matching URL in `.env`.
