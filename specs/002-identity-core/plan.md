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
