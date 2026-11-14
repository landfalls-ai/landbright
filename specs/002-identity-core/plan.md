# Plan 002: Identity core and sign-in

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-12

## Technical context

| Project | What it gains |
|---|---|
| `libs/persistence` (new, `@landbright/persistence`) | Prisma 6 schema and migrations; `withTenant` (Landfall's pattern: `set_config('app.tenant_id', …, true)` in a transaction); the hash-chained audit log (`appendAudit`, `verifyAuditChain`); argon2id passwords; `ensureBootstrap`; `PersistenceModule` (CONFIG, PRISMA, TENANT) |
| `libs/platform` | Config for the database, tenant, secret key, mail and bootstrap; `crypto.ts` (HKDF keys, AES-256-GCM sealing, derived client secrets, link tokens); `createValkey`; `applyServiceDefaults` |
| `libs/contracts` | `directory.ts` (people, agents, groups), `applications.ts`, `audit.ts`, `session.ts` |
| `apps/idp` | `oidc-provider` 9 at `/oidc` with a Postgres adapter, signing keys sealed in Postgres, server-rendered sign-in, invite and sign-out pages under a strict CSP, a per-email lockout in Valkey |
| `apps/control` | Console sign-in as an OIDC client (`openid-client` 6, server-side session in Valkey, cookie `lb_session`); People, Agents, Groups, Applications and Audit APIs; invite mail (nodemailer → Mailpit) |
| `apps/console` | Sign-in gate, user menu, the five pages, Landflow's dialog and input primitives |
| `e2e` (new, `@landbright/e2e`) | The built services as processes against `landbright_test`, driven like a browser and like Landflow |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt plumbing, build the core | PASS | `oidc-provider` (OpenID Certified) for the protocol, `openid-client` for the console, Prisma, argon2 (`@node-rs/argon2`), nodemailer. Landbright writes the directory, sign-in pages and policy, not the protocol. |
| II. Default deny | PASS | Every control route needs a session; directory routes need an administrator (`@Actor()`); `/api/health` is no longer public. Public routes: liveness, OpenAPI, `/api/auth/login` and `/callback` (how sign-in starts and ends), the idp's `/oidc`, `/interaction`, `/invite`, `/assets`, each with its reason in a comment. Row-level security is forced on every tenant table. |
| III. Accountable human | PASS | `agent_profile.sponsor_id` is required and must be an active person; deactivating the sponsor suspends the agent. Only people can be administrators. |
| IV. Policy or a person approves | N/A | No access requests yet (wave 4). Group membership is changed by administrators only, and audited. |
| V. Event-sourced ledger | PARTIAL | The audit log is append-only (a trigger blocks UPDATE and DELETE) and hash-chained, written in the same transaction as the change. The grant ledger proper arrives in wave 4. |
| VI. Standards on the wire | PASS | OIDC discovery, authorization code + PKCE (required), refresh, client credentials, introspection, revocation, RP-initiated logout, RS256 JWKS. |
| VII. Stateless, N-up safe | PASS | Sessions and sign-in state in Valkey; OIDC artefacts in Postgres; signing-key creation under an advisory lock; the audit chain under a per-tenant advisory lock. |
| VIII. Spec-driven, test-backed | PASS | This spec; unit, route, database (`rls.integration.test.ts`) and end-to-end (`e2e/test/signin.test.ts`) tests; a live check in the browser. |
| IX. Local only | PASS | Mail goes to Mailpit; the test database is `landbright_test`; Landflow was read, not changed. |

**Integration Definition of Done (Landflow)**: the e2e copies Landflow's wire behaviour from
`apps/web/src/lib/server/auth/oidc.ts` (token request, ID-token checks, `mappedRole`). A live sign-in to a running
Landflow is left for the user to run, because it changes Landflow's environment.

## Decisions

- **Signing keys in Postgres, sealed** (AES-256-GCM under a key derived from `LANDBRIGHT_SECRET_KEY`), not in OpenBao
  as plan §7 says: OpenBao runs in dev mode, in memory, so keys would be lost at every restart and every token with
  them. OpenBao's transit engine is the target once it persists (docs/limitations.md).
- **Client secrets are derived, never stored**: HMAC of `clientId:version` under a derived key. Rotation bumps the
  version. Nothing in the database can leak a secret.
- **One tenant per deployment** (`LANDBRIGHT_TENANT_SLUG`), with `tenant_id` and row-level security in every table so
  multi-tenancy is a routing change, not a schema change.
- **Group names are the roles.** `roles` and `groups` both carry the person's group names under the `roles` scope;
  Landflow needs `LANDFLOW_OIDC_SCOPES="openid email profile roles"` (its default omits `roles`). Group names can't
  contain `,` or `=`, which Landflow's role map uses.
- **No consent screen**: every application is registered by an administrator, so `loadExistingGrant` grants what it
  asks for (and widens an existing grant when it asks for more).
- **The console is a backend-for-frontend**: control holds the tokens; the browser holds only an HttpOnly, SameSite=Lax
  session id. Because other local apps share the `127.0.0.1` site, writes are also refused unless `Origin` is the
  console's.
- **Passwords via invite**: administrators never set or see a password. The link is a 32-byte token, stored as its
  SHA-256, single-use, 72 hours.
- **Sign-in throttling fails open**: ten failures per email in 15 minutes locks that email; if Valkey is down the
  counter is skipped rather than blocking every sign-in.
- **The superuser bypasses row-level security** even when forced, so only migrations and the bootstrap use the owner,
  and the bootstrap filters by tenant explicitly.

## Passkeys (T010b)

| Project | What it gains |
|---|---|
| `libs/platform` | `LANDBRIGHT_IDP_URL` defaults to `http://localhost:4402`: WebAuthn needs a domain for its relying-party id, and browsers refuse IP addresses. The listener stays on `127.0.0.1` (principle IX). |
| `apps/idp` | `@simplewebauthn/server` 14 for the ceremonies; `PasskeyService` (options, challenges in Valkey, verification, sign counters); routes `POST /interaction/:uid/passkey` (sign in with a passkey alone), `/passkey/verify` (second step), `/passkey/enroll` (add one when offered a second step); `/assets/passkey.js`, the only script, content-hashed, under `script-src 'self'` |
| `libs/contracts`, `apps/control`, `apps/console` | `Person.passkeys` (a count); the person page shows them and **Reset second step** removes them; Settings lists passkeys among the methods when the issuer is a domain |
| `e2e` | A software authenticator (P-256, `none` attestation) that registers and signs like a browser's |

Constitution Check, for this slice: I PASS (`@simplewebauthn/server`, not hand-rolled verification); II PASS (the new
routes are `@Public()` like the rest of the sign-in, and work only with this browser's interaction cookie and a
challenge issued for it); VI PASS (WebAuthn Level 3, `amr` per RFC 8176); VII PASS (challenges in Valkey, single
use; counters updated conditionally); VIII PASS (unit, e2e, live); IX PASS.

Decisions:

- **A passkey is two factors.** User verification is required (`userVerification: 'required'`), so a passkey is
  something you have plus a PIN or biometric. Signing in with one alone satisfies *Require a second step*.
- **`amr`** follows RFC 8176 and says `mfa` whenever two factors were used: `["pwd"]`, `["pwd", "otp", "mfa"]`,
  `["pwd", "pop", "mfa"]`, `["pop", "mfa"]` (a passkey alone). This changes the TOTP slice's `["pwd", "otp"]`.
- **No JavaScript beyond the ceremony.** The pages stay forms: the script fills a hidden field with the
  authenticator's response and submits the form. Without the script, or without WebAuthn, the passkey buttons stay
  hidden and the password path works as before.
- **Discoverable credentials** (`residentKey: 'required'`), so the sign-in page needs no email to offer a passkey.
- **Where passkeys are added**: on the *Add a second step* page, next to the authenticator app. People who already
  have an app have no place to add a passkey until a self-service account page exists (docs/limitations.md).
- **The public key is stored as is** (base64url in `credential.secret`); it isn't a secret.

## Signing-key rotation (T011b)

| Project | What it gains |
|---|---|
| `libs/persistence` | `signing-keys.ts` (moved from the idp): `loadSigningKeys`, `signingKeyFingerprint`, `rotateAfter` (the rule), `rotateSigningKeys` (under the same advisory lock as key creation) |
| `libs/platform` | `LANDBRIGHT_ID_TOKEN_TTL_SECONDS` (default 3600), used for the ID token's lifetime and the rotation rule |
| `apps/idp` | `OidcProviderRef`: the provider, rebuilt when the published key set changes; `/oidc` and the interaction routes go through it |
| `libs/contracts`, `apps/control`, `apps/console` | `SigningKey.status`, `Settings.idTokenTtlSeconds` and `rotateAfter`; `POST /api/settings/signing-keys/rotate` (audited `signing_key.rotated`); Settings → *Rotate* with a confirmation |
| `e2e` | Two rotations in one run (ID tokens live 15 s there): a token signed before the first still verifies, new tokens carry the new `kid`, the second waits with 409, the third retires the oldest key |

Constitution Check, for this slice: I PASS (oidc-provider signs and publishes; Landbright only chooses the keys); II
PASS (rotation is an administrator's action through control, audited); VI PASS (JWKS with `kid`, as relying parties
expect for rotation); VII PASS (keys in Postgres under an advisory lock; every replica follows by checking, no
in-memory coordination); VIII PASS (unit, e2e, live); IX PASS.

Decisions:

- **Two published keys at most.** A rotation keeps the replaced key and retires anything older, so the JWKS stays
  small and a retired key is really gone.
- **Wait rather than break tokens.** A rotation that would retire a key whose ID tokens may still be alive is
  refused until they expire, and Settings says when. Access and refresh tokens are opaque, so only ID tokens matter.
- **The new key signs at once**, with no pre-publication period. Relying parties that cache the JWKS refetch it on an
  unknown `kid` (`openid-client` and `jose` do, with a short cooldown), so a token with the new key verifies on the
  first try or the second.
- **No message bus.** oidc-provider takes its keys at construction, so the identity plane rebuilds the provider; it
  learns about a rotation by comparing the published set at most every five seconds while serving requests, which
  works the same for one replica or several.
- **Keys stay deployment-wide** while one deployment serves one tenant; the rotation is audited in the
  administrator's tenant.

## Conformance suite (T012b)

`pnpm conformance` runs the OpenID Foundation's suite on this machine (`e2e/conformance/run.ts`,
`deploy/conformance/compose.yml`, compose project `landbright-conformance`). The two decisions the investigation
raised were taken this way:

- **PKCE stays required**, except for client ids named in `LANDBRIGHT_PKCE_OPTIONAL_CLIENTS`, which only the
  conformance run sets, for its own three clients (the OIDC Core plans send no `code_challenge`). Empty by default.
- **TLS from a proxy**: Caddy (`tls internal`) answers as `https://idp.landbright.test:8443` and forwards to a dedicated
  identity plane on the host, which trusts `X-Forwarded-Proto` only with `LANDBRIGHT_TRUST_PROXY=true` (oidc-provider's
  `proxy` and Express's `trust proxy`). The name has a dot because Java sends no SNI for a bare host name.

The run: a fresh tenant in `landbright_test`, the identity plane issuing as the proxy's URL, three clients registered
and audited (two `client_secret_basic`, one `client_secret_post`), the suite at release v5.3.4 (images and its runner
script pinned), its browser scripted through Landbright's sign-in page and *Not now*. Nothing is published on a host
port and nothing changes `/etc/hosts`. Log and exported results land in `e2e/conformance/.run/` (git-ignored).

Result of `oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]`,
12 November 2026: of 35 modules, **21 passed**, 5 warnings, 4 skipped, 4 for review, 1 failed.

| Module | Result | Why |
|---|---|---|
| `oidcc-ensure-post-request-succeeds` | failed | POST to the authorization endpoint is off: oidc-provider allows it only with a `SameSite=None` session cookie. Left off (limitations.md). |
| `oidcc-scope-profile` | warning | The userinfo response lacks profile claims Landbright doesn't hold (picture, locale, …). |
| `oidcc-scope-email`, `oidcc-alternate-happy-flow` | warning | The ID token carries the email: Landbright puts the scopes' claims in the ID token because Landflow reads them there. |
| `oidcc-ensure-request-with-acr-values-succeeds` | warning | No `acr` claim. |
| `oidcc-claims-essential` | warning | The `claims` request parameter isn't supported. |
| `oidcc-scope-address`, `-phone`, `-all`; `oidcc-unsigned-request-object-…` | skipped | Those scopes and request objects aren't supported (the suite accepts that). |
| `oidcc-prompt-login`, `oidcc-max-age-1`, `oidcc-ensure-registered-redirect-uri`, `oidcc-ensure-request-object-with-redirect-uri` | review | The suite captured Landbright's sign-in or error page for a person to look at; it does that for every OP. |

**Bug it found, fixed:** an application asking for `prompt=consent` (as `offline_access` needs) looped on
`/interaction`: Landbright shows no consent screen, but the interaction must still answer the consent prompt
(`{ consent: {} }`). The end-to-end tests now cover `prompt=consent` with `offline_access` and a refresh token.
