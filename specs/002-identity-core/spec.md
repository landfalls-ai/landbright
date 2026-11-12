# Feature 002: Identity core and sign-in (wave 1, first slice)

**Status**: first slice implemented 2026-11-12 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md)

## Why

Wave 1's goal is the plan's first slice: **a person created in the console signs into Landflow over OIDC and lands with
the role their group maps to, with no Landflow code changed.** That needs a directory (people, agents, groups), an OIDC
provider that puts group names where Landflow reads roles, a way for a new person to get a password, a console that
administrators sign in to, and an audit log that records all of it.

## User stories

1. **As an administrator**, I open the console and sign in with Landbright itself (the console is an OIDC client of
   the identity plane). Someone who isn't in *Landbright Admins* sees that the console isn't for them.
2. **As an administrator**, I add a person with their department, title, manager and groups. They get an email with a
   one-time link to set a password.
3. **As a new person**, I follow the link, choose a password, and can then sign in to my organization's apps.
4. **As an administrator**, I register Landflow as an application and get its client secret once, with the settings to
   paste into Landflow's `.env`.
5. **As a person in *Landflow Editors***, I click "Sign in with Landbright" in Landflow and land as a `member`, because
   Landflow's `LANDFLOW_OIDC_ROLE_MAP` maps that group, which arrives in the `roles` claim.
6. **As an administrator**, I deactivate someone: they can't sign in, every session and token they hold is revoked at
   once, and the agents they sponsor are suspended.
7. **As an administrator**, I register an agent with its sponsor, purpose, runtime, risk tier and token lifetime
   (credentials for agents arrive in wave 5).
8. **As an auditor**, I read every change (who, what, when) in a log whose events are hash-chained, and the console
   says whether the chain is intact.

## Acceptance

- `pnpm db:setup` creates the tenant, *Landbright Admins*, the first administrator and the console's client; running
  it again changes nothing.
- Every tenant table is under forced row-level security; the services connect as `landbright_app`, which isn't a
  superuser; outside a tenant transaction the tables look empty.
- The issuer serves discovery and JWKS; authorization code requires PKCE; the ID token carries `email`,
  `email_verified`, `name` and, with the `roles` scope, `roles` and `groups` (the person's group names).
- A Landflow-shaped relying party (Basic client authentication plus `client_id` in the body, nonce, PKCE, JWKS
  verification, the role map) signs a new person in with `roles: ["Landflow Editors"]` → `member`
  (`e2e/test/signin.test.ts`).
- A wrong password, a wrong client secret and an unregistered redirect URI are refused.
- Deactivation makes the person's access token inactive at introspection immediately, and sign-in fails.
- The last active administrator can't be removed or deactivated; the console's own client can't be changed from the
  console; writes from another origin are refused.
- Every write appends an audit event in the same transaction; the audit page reports the chain intact.
- `/api/health` answers administrators only.

## Out of scope (later in wave 1 or after)

The second slice took on TOTP and the Settings page ([tasks.md](tasks.md), T010a and T011a).


Passkeys and TOTP; upstream Google/Entra federation; the Settings page (tenant, signing keys, rotation); Playwright and
the OpenID conformance suite; editing applications' redirect URIs from the console (the API supports it); SCIM (wave
2); HR sources (wave 3); agent credentials (wave 5).
