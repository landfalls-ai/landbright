# API reference

The control API's machine-readable description is at `GET /api/openapi.json` (OpenAPI 3.1, generated from
`libs/contracts`), browsable at `/api/docs`. Every route is closed unless listed as public here.

## Identity plane (idp, :4402)

| Route | Access | What |
|---|---|---|
| `GET /healthz` | Public | `Liveness`: `{ status: "ok", service: "landbright-idp", version, uptimeSeconds }`. |
| `/oidc/*` | Public (the protocol authenticates clients itself) | `oidc-provider`: `/.well-known/openid-configuration`, `/auth`, `/token`, `/me` (userinfo), `/jwks`, `/token/introspection`, `/token/revocation`, `/session/end`. [sign-in.md](../sign-in.md) has the scopes and claims. |
| `GET /interaction/:uid` | Public (people who aren't signed in yet) | The sign-in page for an authorization request in progress. |
| `POST /interaction/:uid/login` | Public | Email and password (form). Success continues the authorization, or shows the second step: the code page for someone with an authenticator app, the setup page for someone without one (unless they chose *Not now* in the last 30 days and it isn't required). Failure shows the page again. Locked for 15 min after 10 failures per email. |
| `POST /interaction/:uid/totp` | Public (after the password) | `code` from the authenticator app. A wrong or reused code shows the page again and counts toward the lockout. |
| `POST /interaction/:uid/totp/enroll` | Public (after the password) | `code` confirming the key just shown; saves it and continues. |
| `POST /interaction/:uid/totp/skip` | Public (after the password) | *Not now*: continues and doesn't ask for 30 days. When the tenant requires a second step, shows the setup page again with that message. |
| `GET /interaction/:uid/abort` | Public | Cancel: back to the application with `access_denied`. |
| `GET /invite/:token` · `POST /invite/:token` | Public (the token is the credential) | Set a password from an invite link. 404 page when used or expired. |
| `GET /assets/signin.css?v=<hash>` | Public | The pages' stylesheet: `@land/tokens` plus the sign-in styles. The pages link it with a hash of its content, so it is cached for good. |

## Control (:4401, and the console at :4400/api)

Writes from a browser must come from the console's origin (`LANDBRIGHT_CONSOLE_URL`); others get 403. Errors are
`{ statusCode, message }`; validation errors add `errors[]` with the zod issues.

### Session

| Route | Access | What |
|---|---|---|
| `GET /api/auth/login?returnTo=` | Public (starts sign-in) | 302 to the identity plane. `returnTo` must be a console path; anything else becomes `/`. |
| `GET /api/auth/callback` | Public (ends sign-in) | Exchanges the code, sets `lb_session`, 302 to `returnTo`. On failure 302 to `/?signin=failed` (or `expired`). |
| `GET /api/auth/me` | Session | `Me`: `{ id, displayName, email, admin, tenant: { slug, name } }`. 401 without a session. |
| `POST /api/auth/logout` | Session | Ends the session; `{ redirect }` is the identity plane's sign-out URL. |

### Directory (administrators)

| Route | What |
|---|---|
| `GET /api/people` | `{ items: Person[] }`, by name. A `Person` has its profile, `manager`, `groups`, `hasPassword`, `hasTotp`, `status`. |
| `POST /api/people` | `CreatePerson` → 201 `Person`. `sendInvite` (default true) emails the link. 409 if the email exists. |
| `GET /api/people/:id` · `PATCH /api/people/:id` | One person; `UpdatePerson` (name, department, title, site, manager, dates). |
| `POST /api/people/:id/deactivate` | Blocks sign-in, revokes sessions and tokens, suspends sponsored agents. 400 for yourself, 409 for the last administrator. |
| `POST /api/people/:id/reactivate` | Active again. |
| `POST /api/people/:id/invite` | `InviteResult`: `{ sentTo, expiresAt }`. Cancels earlier links. |
| `POST /api/people/:id/reset-second-step` | → `Person`. Deletes their authenticator app (and passkeys, when there are any). |
| `GET /api/agents` · `POST /api/agents` | `{ items: Agent[] }`; `CreateAgent` (sponsor must be an active person) → 201 `Agent`. |
| `GET /api/agents/:id` · `PATCH /api/agents/:id` | One agent; `UpdateAgent`. |
| `POST /api/agents/:id/suspend` · `/resume` | Resume needs an active sponsor. |
| `GET /api/groups` · `POST /api/groups` | `{ items: Group[] }` with `memberCount` and `system`; `CreateGroup` → 201 `GroupDetail`. 409 on a taken name. |
| `GET /api/groups/:id` · `PATCH` · `DELETE` | `GroupDetail` with `members[]`. *Landbright Admins* can't be renamed (403) or deleted (403). |
| `POST /api/groups/:id/members` | `{ identityId }` → 201 `GroupDetail`. Only people in *Landbright Admins*. 409 if already in. |
| `DELETE /api/groups/:id/members/:identityId` | → `GroupDetail`. 409 for the last administrator. |

### Applications (administrators)

| Route | What |
|---|---|
| `GET /api/applications` | `{ items: Application[], issuer }`. |
| `POST /api/applications` | `CreateApplication` (`name`, optional `clientId`, `redirectUris`, `postLogoutRedirectUris`, `grantTypes`) → 201 `ApplicationWithSecret`: `{ application, clientSecret, issuer }`. The only time the secret is shown, with rotation. 409 on a taken client id. |
| `GET /api/applications/:id` · `PATCH` · `DELETE` | One application; delete revokes its tokens. The console's client answers 403 to changes. |
| `POST /api/applications/:id/rotate-secret` | → `ApplicationWithSecret` with the new secret. |

### Settings (administrators)

| Route | What |
|---|---|
| `GET /api/settings` | `Settings`: `{ tenant: { slug, name }, issuer, signIn: { mfaRequired, methods }, signingKeys[] }`. |
| `PATCH /api/settings/sign-in` | `UpdateSignIn` (`{ mfaRequired }`) → `Settings`. |

### Audit and health (administrators)

| Route | What |
|---|---|
| `GET /api/audit?before=&limit=` | `AuditPage`: `{ items: AuditEvent[], nextBefore, chainIntact }`, newest first, 50 by default (max 200). |
| `GET /api/health` | `HealthReport`: `service`, `version`, `environment`, `status` (`ok`, `degraded`, `down`), `checkedAt`, `components[]` for `idp`, `postgres`, `valkey`, `openbao`, `mailpit`. Always 200; `status` tells. Each probe gives up after 2 s. |

### Public

| Route | What |
|---|---|
| `GET /healthz` | `Liveness` for `landbright-control`. |
| `GET /api/openapi.json` · `GET /api/docs` | The OpenAPI 3.1 document and Swagger UI. |

Any other route answers 401 (`DefaultDenyGuard`) or 404.
