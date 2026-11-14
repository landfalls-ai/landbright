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
- **Revocation reaches the applications Landbright provisions** ([provisioning.md](provisioning.md)): deactivating a
  person sets them inactive in each SCIM target within seconds, and an application with a back-channel logout URI is
  posted a logout token. An application that is neither keeps its own session until it ends. None of Landflow,
  Landfall or Clickland takes logout tokens yet (SCIM covers them).
- **Landflow in a bridged container can't use `localhost:4402`.** Landflow takes every endpoint from the discovery
  document, so the issuer must be reachable from both the browser and the container. Run Landflow on the host, or in a
  container with host networking as `deploy/landflow/compose.yml` does ([suite.md](suite.md#try-it-landflow-signs-in-through-landbright)).
- **Landflow must ask for the `roles` scope** (`LANDFLOW_OIDC_SCOPES="openid email profile roles"`); its default
  doesn't, and then everyone lands with Landflow's default role.
- **Agents aren't synced with Landflow** (wave 5). Their credentials are in [agents.md](agents.md).
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

## Agents (spec 005, slice 3)

- **One application per agent**, made with it (`private_key_jwt`); no agent signs in through a browser (no redirects).
  No SPIFFE or workload identity yet: the agent holds a key pair it was given.
- **Token exchange** takes only access tokens Landbright issued, not `actor_token` (the agent's application is the
  actor), not a sender-constrained subject token, and the exchanged token isn't DPoP-bound itself. No ID-JAG yet.
- **CIBA is poll mode only**; `login_hint` is the person's email (no `login_hint_token`, `id_token_hint`); `user_code`
  is advertised by oidc-provider but ignored (the person signs in). The person hears through Landflow's email flow; no
  push to a phone.
- **DPoP's `jti` cache** on the machine API is in the control process (a restart forgets it; one process only).
- **No consent screen** for an ordinary application: the CIBA and device pages are the only places a person says yes
  to someone acting for them.

## Provisioning (spec 006)

- **Push only.** Landbright is a SCIM client; it isn't a SCIM server (nothing provisions into it), and it doesn't read
  people from an application. No `/Bulk`, and no ETags (a change made in the application between two of Landbright's
  pushes is put back at the next comparison, not refused).
- **People only.** Agents aren't pushed (wave 5). Attributes are email, names and active; no title, department,
  manager or the enterprise extension yet.
- **Group names go as they are.** No per-target renaming: the application maps names itself (Landflow's
  `LANDFLOW_SCIM_GROUP_MAP`, Landfall's group-role mappings), so renaming a group in Landbright changes what it means
  there until the map follows.
- **Landfall:** its session JWT lives up to an hour after deactivation; its routes check membership on every request,
  so access ends at once, but the token isn't revoked (a Landfall limit). It stores no groups (roles come from the
  person's `groups`), ignores email changes, and its user list leaves out accounts made before SCIM was switched on
  (Landbright reads by id, so it isn't affected).
- **Landflow:** deactivation suspends API keys and MCP tokens rather than deleting them, and an open `/api/events`
  stream isn't closed (Landflow limits). An unknown member id in a group is dropped without an error.
- **One worker at a time per tenant**, every 2 seconds; a target answering slowly holds up only itself.
- **Back-channel logout only**, no front-channel logout (iframes the browser loads) and no logout for sessions that
  simply expire (the specification doesn't ask for it). A logout token given up after ten tries (about 85 minutes)
  isn't sent again; it stays in `logout_delivery` with its error and in the ledger.
- **A grant's pushes are read from the audit log**, the last 200 events of its groups and its holder while it was live
  (and removals the day after it ended); pushes recorded before slice 2 name removed members by the application's ids
  and don't show.

## People from HR (spec 007)

- **HiBob only, and checked against its documentation, not a tenant.** There is no HiBob account here: the fake Bob
  answers as the docs say (the machine format, `humanReadable: "APPEND"`, `Bob-Signature`). Shapes waits for its schema
  (plan §11); Workday and others aren't planned.
- **Joiners only.** A changed department, title, manager or site updates the person when an event reaches the upsert,
  but the flow listens only to `employee.created` and `employee.joined`; birthright groups aren't moved for a mover, and
  leavers aren't deactivated from HR (slice 2). Nothing is written back to HiBob.
- **Start dates in UTC.** Someone starting in Tel Aviv becomes active at 02:00 local time (Bob's own `employee.joined`
  comes at local midnight and activates them then). The site's time zone is slice 2.
- **No HR for agents**, and no pre-hire state for anyone created in the console (administrators create active people).
- **The plugins need the Landflow checkout next to this one** (`@landflow/sdk` is private and linked from it), and run
  as separate processes (`pnpm plugins:start`); the Landbright Trigger (a plugin trigger that subscribes itself) is slice
  2, so the Onboard flow still uses a Webhook trigger with a JWT credential.

## Lifted

- Spec 007, slice 1: no way in from HR; `pre_hire` and start dates existed but nothing used them; the machine API couldn't
  create a person.

- Spec 006, slice 2: an application that wasn't provisioned kept a deactivated person's session until it ended; a
  grant didn't show what reached the applications.

- Spec 006: revocation stopped at Landbright; applications learned who existed only at first sign-in; just-in-time
  access to Landflow projects needed a provisioning flow.

- Spec 005, slice 3: agents were directory entries without credentials; no token exchange, CIBA, device grant, PAR or
  DPoP. An application's secret could only be sent as basic (now `client_secret_post` too). The services listened on
  127.0.0.1 only (now [::1] too).

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
