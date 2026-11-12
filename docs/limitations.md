# Limitations

What Landbright doesn't do yet, and what each item waits for. [roadmap.md](roadmap.md) has the order.

## Now (wave 1)

- **Password, authenticator app and passkeys.** Upstream Google/Entra federation comes after wave 1. There is no
  self-service "forgot password" or recovery codes: an administrator sends a new invite (a password reset) or resets the
  second step.
- **No account page.** People add a passkey or an app only when offered a second step at sign-in, so someone with an
  app can't add a passkey (or a second passkey) without an administrator's reset, and can't name or remove their own.
  A self-service account page comes later.
- **Passkeys need the issuer on a domain.** `LANDBRIGHT_IDP_URL` is `http://localhost:4402` for that; with an IP
  address there, passkeys are off. Passkeys are bound to that host, so moving the issuer to another host makes the
  existing ones unusable (reset the second step).
- **A second step is all or nothing.** *Require a second step* applies to everyone in the tenant; per-group or
  per-application rules (step-up for admin roles, `acr_values`) come with policy in wave 6. Applications can read
  `amr` meanwhile.
- **Signing keys live in Postgres, sealed with `LANDBRIGHT_SECRET_KEY`, not in OpenBao** as plan §7 says. OpenBao
  runs in dev mode, in memory, so keys kept there would vanish (and every token with them) at each restart. Moving to
  OpenBao's transit engine waits for a persistent OpenBao.
- **Signing keys rotate by hand only** (Settings → *Rotate*), and only RS256. No schedule yet, and no ES256 or EdDSA
  keys for relying parties that prefer them.
- **One tenant per deployment.** Every table carries `tenant_id` under row-level security, but the services serve the
  tenant named by `LANDBRIGHT_TENANT_SLUG`, and client ids are global.
- **Revocation stops at Landbright.** Deactivating a person revokes their sessions and tokens at the identity plane at
  once, but an application that checked the ID token only at sign-in keeps its own session until it ends. Pushing the
  change (SCIM, back-channel logout) is wave 2.
- **Landflow in a bridged container can't use `localhost:4402`.** Landflow takes every endpoint from the discovery
  document, so the issuer must be reachable from both the browser and the container. Run Landflow on the host, or in a
  container with host networking as `deploy/landflow/compose.yml` does ([suite.md](suite.md#try-it-landflow-signs-in-through-landbright)).
- **Landflow must ask for the `roles` scope** (`LANDFLOW_OIDC_SCOPES="openid email profile roles"`); its default
  doesn't, and then everyone lands with Landflow's default role.
- **Agents are directory entries only.** No credentials, tokens or Landflow sync until wave 5.
- **No consent screen.** Every application is registered by an administrator and gets the scopes it asks for.
  Third-party and agent clients get policy-based consent in wave 5.
- **Sign-in lockout fails open.** When Valkey is down, failed sign-ins aren't counted, so there is no lockout until it
  is back.
- **The console's Applications page can't edit redirect URIs** (the API can: `PATCH /api/applications/:id`).
- **The authorization endpoint takes GET only.** OIDC Core says it must take POST too; oidc-provider turns POST off
  unless the session cookie is `SameSite=None`, which lets other sites' forms carry it. Left off until there is a
  client that needs POST; the one OpenID conformance test that checks it fails
  ([spec 002 plan](../specs/002-identity-core/plan.md#conformance-suite-t012b)).
- **Other conformance warnings, by choice or not yet.** The ID token carries the scopes' claims (email, name, roles)
  because Landflow reads them there; no `acr` claim; no `address` or `phone` scopes; no `claims` request parameter; no
  request objects (refused with `request_not_supported`). Firefox and Safari aren't covered by the browser tests.
- **No Kubernetes manifests.** The plan's `landbright-dev` namespace on OrbStack comes when there is something worth
  running there; compose and `pnpm serve` cover development.
- **The console is one bundle.** Route-level splitting waits until it matters.
- **Tokens are a copy.** `@land/tokens` duplicates Landflow's `globals.css` blocks; a test catches drift until Landflow
  adopts the package.
- **The Landflow changes L1–L5** (plan §3.5) are not filed as Landflow specs yet. Wave 1 needed none of them.

## Lifted

- Wave 1: `GET /api/health` is for administrators now (it was public in wave 0). There are identities, sign-in and a
  tenant.
