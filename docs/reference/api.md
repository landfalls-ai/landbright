# API reference

The control API's machine-readable description is at `GET /api/openapi.json` (OpenAPI 3.1, generated from
`libs/contracts`), browsable at `/api/docs`. Every route is closed unless listed as public here.

## Identity plane (idp, :4402)

| Route | Access | Answers |
|---|---|---|
| `GET /healthz` | Public | `Liveness`: `{ status: "ok", service: "landbright-idp", version, uptimeSeconds }`. Says only that the process serves. |

## Control (:4401, and the console at :4400/api)

| Route | Access | Answers |
|---|---|---|
| `GET /healthz` | Public | `Liveness` for `landbright-control`. |
| `GET /api/health` | Public (wave 0 only; see limitations) | `HealthReport`: `service`, `version`, `environment`, `status` (`ok`, `degraded`, `down`), `checkedAt`, and `components[]`, one each for `idp`, `postgres`, `valkey`, `openbao`, `mailpit`: `{ id, name, kind, status: up/down, latencyMs, target: "host:port", detail? }`. Always 200; `status` tells. Each probe gives up after 2 s. |
| `GET /api/openapi.json` | Public | The OpenAPI 3.1 document. |
| `GET /api/docs` | Public | Swagger UI over it. |

Any other route answers 401 (`DefaultDenyGuard`) or 404.
