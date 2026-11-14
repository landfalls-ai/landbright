# API reference

The control API's machine-readable description is at `GET /api/openapi.json` (OpenAPI 3.1, generated from
`libs/contracts`), browsable at `/api/docs`. Every route is closed unless listed as public here.

## Identity plane (idp, :4402)

| Route | Access | What |
|---|---|---|
| `GET /healthz` | Public | `Liveness`: `{ status: "ok", service: "landbright-idp", version, uptimeSeconds }`. |
| `/oidc/*` | Public (the protocol authenticates clients itself) | `oidc-provider`: `/.well-known/openid-configuration`, `/auth`, `/token`, `/me` (userinfo), `/jwks`, `/token/introspection`, `/token/revocation`, `/session/end`. [sign-in.md](../sign-in.md) has the scopes and claims. |
| `GET /interaction/:uid` | Public (people who aren't signed in yet) | The sign-in page for an authorization request in progress. |
| `POST /interaction/:uid/login` | Public | Email and password (form). Success continues the authorization, or shows the second step: the code or passkey page for someone with one set up, the setup page for someone without one (unless they chose *Not now* in the last 30 days and it isn't required). Failure shows the page again. Locked for 15 min after 10 failures per email. |
| `POST /interaction/:uid/totp` | Public (after the password) | `code` from the authenticator app. A wrong or reused code shows the page again and counts toward the lockout. |
| `POST /interaction/:uid/totp/enroll` | Public (after the password) | `code` confirming the key just shown; saves it and continues. |
| `POST /interaction/:uid/passkey` | Public (people who aren't signed in yet) | `response`: a passkey assertion (JSON, from `/assets/passkey.js`) against the challenge on the sign-in page. Signs in with the passkey alone. |
| `POST /interaction/:uid/passkey/verify` | Public (after the password) | `response`: an assertion from one of this person's passkeys, as the second step. Failures count toward the lockout. |
| `POST /interaction/:uid/passkey/enroll` | Public (after the password) | `response`: a new passkey (attestation `none`, user verification required); saves it and continues. |
| `POST /interaction/:uid/recovery` | Public (after the password) | `code`: a recovery code instead of the second step. Works once; a wrong one counts toward the lockout. |
| `POST /interaction/:uid/actions/password` | Public (after sign-in, before the app) | The `update_password` required action: `password`, `confirm` (at least 12 characters, not the current one). |
| `POST /interaction/:uid/actions/terms` | Public (after sign-in, before the app) | The `accept_terms` required action: `accept=yes`. |
| `POST /interaction/:uid/totp/skip` | Public (after the password) | *Not now*: continues and doesn't ask for 30 days. When the tenant requires a second step, shows the setup page again with that message. |
| `GET /interaction/:uid/abort` | Public | Cancel: back to the application with `access_denied`. |
| `GET /invite/:token` · `POST /invite/:token` | Public (the token is the credential) | Set a password from an invite link. 404 page when used or expired. |
| `GET /forgot?uid=` · `POST /forgot?uid=` | Public (they can't sign in) | Forgot password: `email`. Always *Check your email*; an active person gets a 30-minute link. 3 links an hour per address, 10 requests per 15 min per client (429). `uid` links back to the sign-in in progress. |
| `GET /reset/:token` · `POST /reset/:token` | Public (the token is the credential) | Choose a new password from that link (or an administrator's *Email them* with `update_password`). Ends every session of theirs. 404 page when used or expired. |
| `GET /account` | Their session (else a sign-in through `landbright-account`) | The account page ([account.md](../account.md)). `?m=` shows a message. |
| `GET /account/signed-in` · `GET /account/confirm` | Public · their session | Where the account client's sign-in lands; *confirm* signs in again (`max_age=0`) before a sensitive change. |
| `POST /account/password` | Their session, `csrf` | `current`, `password`, `confirm`. |
| `GET /account/totp` · `POST /account/totp` | Their session, recent sign-in | Add an authenticator app: the QR code (its key kept for this session for 10 minutes), then `code`. |
| `POST /account/passkeys` | Their session, `csrf`, recent sign-in | `response`: a new passkey. |
| `POST /account/credentials/:id/remove` | Their session, `csrf`, recent sign-in | Removes an app or passkey; not the last when the tenant requires a second step. |
| `POST /account/recovery-codes` | Their session, `csrf`, recent sign-in | Ten new codes, shown once; the old ones stop working. |
| `POST /account/sessions/end-others` | Their session, `csrf` | Ends their other sessions. |
| `GET /assets/signin.css?v=<hash>` | Public | The pages' stylesheet: `@land/tokens` plus the sign-in styles. The pages link it with a hash of its content, so it is cached for good. |
| `GET /assets/passkey.js?v=<hash>` | Public | The pages' only script: runs the WebAuthn ceremony for a `form[data-passkey]` and submits it. Content-hashed like the stylesheet. |

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
| `GET /api/people` | `{ items: Person[] }`, by name. A `Person` has its profile, `manager`, `groups`, `hasPassword`, `hasTotp`, `passkeys` and `recoveryCodes` (counts), `requiredActions`, `termsAcceptedAt`, `status`. |
| `POST /api/people` | `CreatePerson` → 201 `Person`. `sendInvite` (default true) emails the link. 409 if the email exists. |
| `GET /api/people/:id` · `PATCH /api/people/:id` | One person; `UpdatePerson` (name, department, title, site, manager, dates). |
| `POST /api/people/:id/deactivate` | Blocks sign-in, revokes sessions and tokens, suspends sponsored agents. 400 for yourself, 409 for the last administrator. |
| `POST /api/people/:id/reactivate` | Active again. |
| `POST /api/people/:id/invite` | `InviteResult`: `{ sentTo, expiresAt }`. Cancels earlier links. |
| `POST /api/people/:id/reset-second-step` | → `Person`. Deletes their authenticator app, passkeys and recovery codes. |
| `POST /api/people/:id/required-actions` | `SetRequiredActions` (`actions`: `update_password`, `configure_second_step`, `accept_terms`; `notify`, default false) → `Person`. Replaces the list. With `notify`, emails them; with `update_password` too, the mail has a one-time link to `/reset` (72 hours). |
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
| `POST /api/applications` | `CreateApplication` (`name`, optional `clientId`, `redirectUris`, `postLogoutRedirectUris`, `grantTypes`, `apiScopes`: the [machine API](#machine-api-apiv1) scopes it may get with client credentials, `minimumAcr`: the weakest sign-in it accepts, `urn:landbright:acr:pwd`, `:mfa` or `:phr`, or null) → 201 `ApplicationWithSecret`: `{ application, clientSecret, issuer }`. The only time the secret is shown, with rotation. 409 on a taken client id. |
| `GET /api/applications/:id` · `PATCH` · `DELETE` | One application; delete revokes its tokens. The console's client answers 403 to changes. |
| `POST /api/applications/:id/rotate-secret` | → `ApplicationWithSecret` with the new secret. |

### Settings (administrators)

| Route | What |
|---|---|
| `GET /api/settings` | `Settings`: `{ tenant: { slug, name }, issuer, signIn: { mfaRequired, methods }, signingKeys[] (kid, alg, status signing/verifying/retired, dates), idTokenTtlSeconds, rotateAfter }`. `methods` has `passkey` when the issuer is a domain. |
| `PATCH /api/settings/sign-in` | `UpdateSignIn` (`{ mfaRequired }`) → `Settings`. |
| `POST /api/settings/signing-keys/rotate` | → `RotationResult` (`{ kid, retired[], settings }`): a new key signs, the replaced key keeps verifying, older keys are retired; audited as `signing_key.rotated`. 409 while the replaced key's ID tokens could still be alive (`Settings.rotateAfter` says until when). |

### Access (spec 004, [access.md](../access.md))

| Route | Access | What |
|---|---|---|
| `GET /api/bundles` · `POST` · `GET /api/bundles/:id` · `PATCH` | Administrators | `Bundle`: name, description, owner, `groupIds`, `targets[]`, `policy`, `disabled`. Audited as `bundle.created` / `bundle.updated`. |
| `GET /api/access/bundles` | Any person | The bundles the signed-in person may ask for. |
| `POST /api/access/requests/preview` | Any person | `{ bundleId, subjectId?, durationMinutes? }` → `RequestPreview`: eligible or why not, who would decide, an auto-approve rule, break-glass, a waiting request it would replace. |
| `POST /api/access/requests` | Any person | `CreateRequest` (`bundleId`, `subjectId` for a sponsored agent, `durationMinutes`, `reason`, `ticket`, `startsAt`, `breakGlass`) → 201 `AccessRequestView`. 403 with the reason when the policy refuses. |
| `GET /api/access/requests?scope=mine\|to-decide\|all&status=` | Any person (`all`: administrators) | `{ items: AccessRequestView[] }`. |
| `GET /api/access/requests/:ref` | Who asked, who it's for, who decides, administrators | By id or by number (`REQ-12`). `actions` says what the caller may do. |
| `POST /api/access/requests/:id/decision` | People the policy names | `{ outcome: approve\|deny, comment? }` → `AccessRequestView`. 403 with the reason otherwise (`request.decision_refused` is audited). |
| `POST /api/access/requests/:id/cancel` | Who asked | A waiting request. |
| `GET /api/access/grants?status=` | Administrators | `{ items: GrantSummary[] }`, newest first. |
| `POST /api/access/grants/:id/revoke` | Administrators, and the holder | `{ comment? }`: ends it now. |
| `POST /api/access/grants/:id/extend` | The holder (or the sponsor of the agent holding it) | `{ durationMinutes, reason? }` → 201 `AccessRequestView` with `extends: { grantId, ref }`: a request of its own, through the bundle's steps. Approved, the grant's end moves (`grant.extended`). 400 when the policy allows no more (`extensions`). |

### Events (administrators, [events.md](../events.md))

| Route | What |
|---|---|
| `GET /api/events/subscriptions` | `{ items: Subscription[] (with delivery counts), eventTypes[] }`. |
| `POST /api/events/subscriptions` | `{ url, events[], description?, audience?, replay? }` → 201. Events are types or prefixes (`grant.*`, `*`). |
| `PATCH /api/events/subscriptions/:id` · `DELETE` | `{ events?, description?, disabled? }`. |
| `GET /api/events/subscriptions/:id/deliveries?status=` | The last 100: status, attempts, last HTTP status and error, the receiver's answer. |
| `POST /api/events/deliveries/:id/resend` | Sends it again. |

### Machine API (`/api/v1`)

For flows and services: `Authorization: Bearer <access token>` from the identity plane's token endpoint with
`grant_type=client_credentials` and `resource=urn:landbright:api` (a JWT, 10 minutes). The token carries the scopes the
application asked for and holds (`apiScopes`). A session cookie doesn't work here, and a token doesn't work elsewhere.

| Route | Scope | What |
|---|---|---|
| `GET /api/v1/requests/:id` | `requests:read` | `AccessRequestView` (by id or `REQ-n`); `actions.decide` is always false. |
| `POST /api/v1/requests` | `requests:create` | `ServiceCreateRequest` (`bundleId`, `subjectId`, `durationMinutes?`, `reason?`, `ticket?`, `startsAt?`) → 201. For an agent: the agent asks, its sponsor is `actingFor` (and can't approve), at most `agentMaxDurationMinutes`. For a person: never auto-approved. An agent's own application may ask only for that agent. No break-glass. |
| `POST /api/v1/requests/:id/relay-tickets` | `decisions:relay` | `{ items: [{ decider, ticket, expiresAt }] }`: one ticket per approver of the current step who hasn't voted, valid until the deadline. 403 when the step doesn't allow chat votes. Audited (`request.relay_tickets_issued`). |
| `POST /api/v1/requests/:id/decisions` | `decisions:relay` | `{ ticket, outcome, comment?, channel: chat:<name>, evidence? }` → `AccessRequestView`. The vote is the ticket's approver's, recorded with `assurance: chat` and the application as `submittedBy`; every rule of a decision still applies, and the ticket must be for this request and its current step. |
| `POST /api/v1/requests/:id/waits` | `requests:read` | `{ resumeUrl }`: POSTed when a vote is recorded, the request is decided or escalates; a failed call is tried again with back-off for a day. The URL's origin must be an enabled subscription's. Kept as the annotation `wait.<client id>`. |
| `PUT /api/v1/requests/:id/annotations/:key` | `annotations:write` | `{ value }`, `If-Match: <version>` to compare and set (409 on a mismatch). Keys are lowercase (`landflow.run`). |
| `GET /api/v1/grants?status=&type=` | `requests:read` | Grants, optionally only those with a target of `type`. |
| `GET /api/v1/grants/:id` | `requests:read` | One grant with its targets and their config. |
| `PUT /api/v1/grants/:id/annotations/:key` | `annotations:write` | As for requests. |
| `POST /api/v1/grants/:id/targets/:key` | `grants:record` | `{ status: provisioned\|failed\|revoked\|revoke_failed\|verified\|drift, detail?, externalRef? }`. Only for targets a flow manages; 409 for a move the target's state doesn't allow (a late `provisioned` after the end). |
| `GET /api/v1/people?inactiveSince=<ISO date>` | `directory:read` | Active people with no sign-in since then (or never, and created before then). |
| `GET /api/v1/people/:id` | `directory:read` | One `Person`. |
| `POST /api/v1/people/:id/required-actions` | `directory:write` | As the console's, with the application as actor. |
| `GET /api/v1/groups?name=` | `directory:read` | `{ items: Group[] }`, optionally the one with that exact name. |
| `POST /api/v1/groups/:id/members` | `directory:write` | `{ identityId, expiresAt? }` → 200 `GroupDetail`. Recorded with source `hr`; already a member is not an error. 403 for *Landbright Admins*, 409 for a deactivated identity. |
| `DELETE /api/v1/groups/:id/members/:identityId` | `directory:write` | → `GroupDetail`. Not a membership a grant gave (409; the grant ends it) and not *Landbright Admins* (403). |
| `POST /api/v1/people/:id/deactivate` | `directory:write` | `{ reason? }`: what the console's deactivation does (sessions, tokens, grants, sponsored agents), audited with the application as actor. |

| `GET /api/v1/subscriptions` · `POST` · `DELETE /api/v1/subscriptions/:id` | `events:manage` | The application's own subscriptions (`ownerClientId`), as in the console's Events. A new one must be at an origin among the application's redirect URIs. |

Update routes (`PATCH`) change only the fields they name; a field left out keeps its value.

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
