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
| `LANDBRIGHT_IDP_URL` | `http://127.0.0.1:4402` | control (health probe). Wave 1: the issuer URL. |
| `LANDBRIGHT_DATABASE_URL` | `postgres://landbright:landbright-dev-only@127.0.0.1:57432/landbright` | control |
| `LANDBRIGHT_VALKEY_URL` | `redis://127.0.0.1:57379` | control |
| `LANDBRIGHT_OPENBAO_ADDR` | `http://127.0.0.1:57200` | control (health probe). Wave 1: signing keys. |
| `LANDBRIGHT_OPENBAO_TOKEN` | `landbright-dev-only` | Wave 1: signing keys |
| `LANDBRIGHT_MAILPIT_URL` | `http://127.0.0.1:57825` | control (health probe) |
| `LANDBRIGHT_INTEGRATION` | unset | Tests: comma-separated suites against real services (`infra`, `all`) |

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
