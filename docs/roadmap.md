# Roadmap

The waves of [plan.md §9](plan.md#9-waves). Each wave ends with `pnpm verify` green, a live check on the local stack
and in the browser, and its bugs fixed in the same wave. The console's Home page shows the same list
(`apps/console/src/waves.ts`).

| Wave | Status | First slice |
|---|---|---|
| **0. Foundations** | ✓ Done 2026-11-12 ([spec 001](../specs/001-foundations/spec.md)) | `pnpm dev:up && pnpm serve` brings up a console in Landflow's shell with a health page |
| **1. Identity core and sign-in** | In progress: identity core, the second step and passkeys done 2026-11-12 ([spec 002](../specs/002-identity-core/spec.md)) | A person created in the console signs into Landflow over OIDC and lands with the role their group maps to |
| **2. Provisioning out** | Planned | Deactivating a person signs them out of Landflow within seconds |
| **3. Landflow plugins and HR lifecycle** | Planned | A signed HiBob `employee.joined` creates the person and adds birthright groups |
| **4. Just-in-time access** | First slice done 2026-11-14, ahead of waves 2–3 ([spec 004](../specs/004-access-and-events/spec.md)) | Editor on a Landflow project for 2 hours: requested, approved in Slack, granted, removed at expiry |
| **5. Agentic identity** | Planned | A Landflow agent gets 15 minutes of read access with its sponsor's approval; the token names both |
| **6. Policy, reviews, signals** | Planned | A sev1 Landfall incident gives the on-call responder the incident bundle until the room closes |

## Wave 0: what it built

Workspace (pnpm + Nx), `apps/idp` and `apps/control` (NestJS 11) with Helmet and a default-deny guard, the console
(React 19 + Vite, Landflow's shell and primitives) with Home and Health, `@land/tokens`, `@landbright/contracts`,
`@landbright/platform`, the `landbright-infra` compose stack (Postgres, Valkey, Mailpit, OpenBao), OpenTelemetry, the
`pnpm verify` gate, the constitution and the spec-kit templates, and these docs.

## Wave 1: what the first slice built

The slice works end to end: a person added in the console sets a password from the invite email, signs in to a
Landflow-shaped application over OIDC and gets the role their group maps to.

- `libs/persistence`: Prisma schema and migrations with forced row-level security, the hash-chained audit log,
  argon2id passwords, the bootstrap (`pnpm db:setup`).
- The identity plane: `oidc-provider` at `/oidc` (code + PKCE, refresh, client credentials, introspection,
  revocation, logout), sealed signing keys, sign-in and invite pages, lockout.
- Control: console sign-in, people, agents, groups, applications, audit, invite mail.
- The console: the sign-in gate and the Directory, Applications and Audit pages.
- `e2e/`: the whole flow against the built services, including deactivation revoking tokens.

The second slice adds an authenticator app (TOTP) as a second step at sign-in: offered to everyone, required when
**Settings → Require a second step** is on, reset by an administrator, and reported to applications in `amr`. The
console gains the Settings page.

The third slice adds passkeys: signing in with one alone, using one as the second step, adding one when offered. The
issuer moves to `localhost`, which WebAuthn needs.

Then real Chromium: a Playwright story drives the console and the sign-in pages end to end, passkeys included, and
captures every screen ([screens.md](screens.md)).

Signing keys rotate from Settings, with the replaced key published until its ID tokens expire.

The OpenID conformance suite runs locally (`pnpm conformance`): 21 of 35 modules of the OIDC basic plan pass, the
rest are warnings, skips and reviews by choice, and one failure (POST to the authorization endpoint) is left off on
purpose. It found a bug, fixed: `prompt=consent` looped.

The real Landflow signs in through Landbright: its own image, a throwaway instance, groups mapped to its roles, and a
deactivated person refused ([suite.md](suite.md#try-it-landflow-signs-in-through-landbright)).

Wave 1 is complete.

## Wave 4: what the first slice built (ahead of order)

The user asked for two studies: Keycloak, reverse-engineered with Craft Anything, and the open-source just-in-time
access projects. They also set one rule: the flows are Landflow flows. Both studies said the same thing: Landbright
decides, records and emits; Landflow runs the processes ([spec 004](../specs/004-access-and-events/spec.md)).

- **Access**: bundles with policies (steps, approver fallback, durations, reason and ticket, auto-approve with
  evidence, break-glass, escalation), requests with numbered references, decisions by signed-in people the policy names
  (standing memberships only, deny wins), grants that add and remove group memberships, and per-target state for what
  flows provision ([access.md](access.md)).
- **Events out**: every audit event, delivered at least once as a JWT signed with the issuer's key, with retries and
  resend; waits that wake a Landflow run ([events.md](events.md)).
- **Machine API** `/api/v1` under client-credentials tokens with scopes.
- **Three Landflow flows** and an installer: approve a request by email; provision and revoke a Landflow project role;
  disable inactive people ([landflow-flows.md](landflow-flows.md)).
- **The console**: Requests and the decision page for everyone; Grants, Catalog and Events for administrators.
- Live check: in the real Landflow, the whole loop from asking to revoking.

Next, from the Keycloak study: required actions and *forgot password*, an account page, `acr`, an *Onboard* flow (spec 005, slice 2, below).

### Spec 005, slice 1: access follow-ups

Extensions; requests services file (agents, intake flows); votes from Slack with per-approver tickets, and two Slack
flows; tokens that end with the grant; subscriptions an application manages itself; wake-ups that retry; the full
policy editor, with auto-approve hours ([spec 005](../specs/005-follow-ups/spec.md)).

### Spec 005, slice 2: the identity plane's own pages

Required actions (a new password, a second step, the terms) set by an administrator or a flow; *Forgot your
password*; the account page (password, authenticator app, passkeys, recovery codes, sessions); recovery codes at
sign-in; `acr` in the ID token, a minimum per application and `acr_values` step-up; the machine API for people and
groups; the *Onboard* flow in Landflow ([account.md](account.md)).

Next (slice 3): agent applications with `private_key_jwt`, token exchange with `act`, CIBA with Landflow as the
channel, the device grant, PAR and DPoP.
