# Limitations

What Landbright doesn't do yet, and what each item waits for. [roadmap.md](roadmap.md) has the order.

## Now (wave 1)

- **Password and authenticator app only.** Passkeys are the next slice of wave 1 (the identity plane has to move to
  `localhost`, since WebAuthn refuses IP addresses); upstream Google/Entra federation comes after. There is no
  self-service "forgot password" or recovery codes: an administrator sends a new invite (a password reset) or resets the
  second step.
- **A second step is all or nothing.** *Require a second step* applies to everyone in the tenant; per-group or
  per-application rules (step-up for admin roles, `acr_values`) come with policy in wave 6. Applications can read
  `amr` meanwhile.
- **Signing keys live in Postgres, sealed with `LANDBRIGHT_SECRET_KEY`, not in OpenBao** as plan §7 says. OpenBao
  runs in dev mode, in memory, so keys kept there would vanish (and every token with them) at each restart. Moving to
  OpenBao's transit engine waits for a persistent OpenBao. There is one key and no rotation yet (Settings shows it; rotation is
  later in wave 1).
- **One tenant per deployment.** Every table carries `tenant_id` under row-level security, but the services serve the
  tenant named by `LANDBRIGHT_TENANT_SLUG`, and client ids are global.
- **Revocation stops at Landbright.** Deactivating a person revokes their sessions and tokens at the identity plane at
  once, but an application that checked the ID token only at sign-in keeps its own session until it ends. Pushing the
  change (SCIM, back-channel logout) is wave 2.
- **Landflow in a container can't use `127.0.0.1:4402`.** Landflow takes every endpoint from the discovery document,
  so the issuer must be reachable from both the browser and the container. Run Landflow on the host for now.
- **Landflow must ask for the `roles` scope** (`LANDFLOW_OIDC_SCOPES="openid email profile roles"`); its default
  doesn't, and then everyone lands with Landflow's default role.
- **Agents are directory entries only.** No credentials, tokens or Landflow sync until wave 5.
- **No consent screen.** Every application is registered by an administrator and gets the scopes it asks for.
  Third-party and agent clients get policy-based consent in wave 5.
- **Sign-in lockout fails open.** When Valkey is down, failed sign-ins aren't counted, so there is no lockout until it
  is back.
- **The console's Applications page can't edit redirect URIs** (the API can: `PATCH /api/applications/:id`).
- **No browser or conformance suites yet.** The end-to-end test drives the services over HTTP; Playwright and the
  OpenID conformance suite are still to come in wave 1.
- **No Kubernetes manifests.** The plan's `landbright-dev` namespace on OrbStack comes when there is something worth
  running there; compose and `pnpm serve` cover development.
- **The console is one bundle.** Route-level splitting waits until it matters.
- **Tokens are a copy.** `@land/tokens` duplicates Landflow's `globals.css` blocks; a test catches drift until Landflow
  adopts the package.
- **The Landflow changes L1–L5** (plan §3.5) are not filed as Landflow specs yet. Wave 1 needed none of them.

## Lifted

- Wave 1: `GET /api/health` is for administrators now (it was public in wave 0). There are identities, sign-in and a
  tenant.
