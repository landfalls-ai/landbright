# Limitations

What Landbright doesn't do yet, and what each item waits for. [roadmap.md](roadmap.md) has the order.

## Now (wave 1)

- **Password, authenticator app and passkeys.** Upstream Google/Entra federation comes after wave 1.
- **The account page can't rename a passkey or change a profile.** Names and departments come from the directory (an
  administrator, or HR through Landflow). No email change, no linked accounts, no consent list.
- **Recovery codes don't recover a lost password** (that is *Forgot your password*), and there is no recovery by
  email or phone for a lost second step without codes: an administrator resets it.
- **Passkeys need the issuer on a domain.** `LANDBRIGHT_IDP_URL` is `http://localhost:4402` for that; with an IP
  address there, passkeys are off. Passkeys are bound to that host, so moving the issuer to another host makes the
  existing ones unusable (reset the second step).
- **Per-application sign-in strength, not per-group.** An application can need a second step or a passkey
  (`minimumAcr`, `acr_values`), and *Require a second step* covers the tenant; a rule for a group (administrators
  always with a passkey) comes with policy in wave 6. The `acr` values are Landbright's own URNs, not a standard
  profile's (NIST or eIDAS levels).
- **Required actions are three.** No *verify email*, *update profile* or *configure a passkey* (the second step takes
  either); terms are one link for the tenant (`LANDBRIGHT_TERMS_URL`), accepted once, without versions.
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
  because Landflow reads them there; no `address` or `phone` scopes; no `claims` request parameter; no
  request objects (refused with `request_not_supported`). Firefox and Safari aren't covered by the browser tests.
- **No Kubernetes manifests.** The plan's `landbright-dev` namespace on OrbStack comes when there is something worth
  running there; compose and `pnpm serve` cover development.
- **The console is one bundle.** Route-level splitting waits until it matters.
- **Tokens are a copy.** `@land/tokens` duplicates Landflow's `globals.css` blocks; a test catches drift until Landflow
  adopts the package.
- **The Landflow changes L1–L5** (plan §3.5) are not filed as Landflow specs yet. Wave 1 needed none of them.

## Access and events (spec 004, first slice)

- **Slack approvals were checked against a stand-in**, not a Slack workspace: the flows ran in the real Landflow, with
  a local server answering `users.lookupByEmail` and `chat.postMessage` and a click posted the way Slack posts it. The
  *Slack approval buttons* flow can't check Slack's request signature (the core Code node has no `crypto`); the ticket
  in the button is what makes a vote count. A native Landbright node in Landflow (spec 003 phase 4) is still later.
- **Auto-approve rules know standing memberships, duration and hours.** No on-call schedule or ticket status yet.
- **Event deliveries** (25 every 2 seconds, in parallel across subscriptions) stop after 24 hours of failures; a failed
  one is resent by hand. Wake-ups also give up after a day.
- **A token issued before a grant was revoked early** lives to its own end (capped at the grant's planned end); the
  next token drops the group.
- **The flows' email** goes through Mailpit's HTTP API, because the throwaway Landflow has only core nodes; with
  Landflow's messaging plugin, use its Send Email or Slack nodes.
- **The *Onboard* flow's groups are a map in its Code node** (by department). Changing a department later doesn't
  move anyone: a *mover* flow is next. Birthright memberships are ordinary memberships with source `hr`.

## Lifted

- Spec 005, slice 2: no self-service *forgot password*, recovery codes or account page; a second step all or nothing
  (applications now set a minimum, and ask with `acr_values`); no `acr` claim; required actions (Keycloak's) and an
  *Onboard* flow were next.

- Spec 005, slice 1: approvals only in the console (chat votes with tickets); no extensions; the bundle form edited
  one step (the full policy editor); no time-of-day rules (`window`); agents' requests only through the sponsor
  (`requests:create`); tokens outliving the grant's planned end; wake-ups not retried; sequential deliveries;
  administrator-only subscriptions (`events:manage`).

- Spec 004: "Agents are directory entries only" still holds, but people can now get access for a while (wave 4 brought
  forward), and the console is open to every person for their requests.

- Wave 1: `GET /api/health` is for administrators now (it was public in wave 0). There are identities, sign-in and a
  tenant.
