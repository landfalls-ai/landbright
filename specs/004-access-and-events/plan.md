# Plan 004: Just-in-time access and events out

[Spec](spec.md) · [Tasks](tasks.md). Built on spec 003's design ([plan](../003-access-requests-and-approvals/plan.md)),
with the changes the research asked for. Checked against Landflow's live source and its running image
(`landflow/host:dev`).

## How the studies were done

- **Keycloak 26.4.7** ran locally (`deploy/keycloak/compose.yml`, project `landbright-keycloak`) with the
  experimental features on. Craft Anything (CLI 0.6.1, signed and notarized) did the following:
  - recorded walkthroughs of 27 admin console pages;
  - analyzed the console's JavaScript (341 routes);
  - read Keycloak's jars for the workflow, event and federated-authentication classes;
  - wrote a report from 8 findings and 39 evidence records.

  `rebuild` and `chat` weren't used. The admin REST API was exercised with curl to test workflows, token exchange,
  CIBA, brute force and events. [research/keycloak-study.md](research/keycloak-study.md) has the gap table and the
  order of work; [research/keycloak-craft-anything-report.md](research/keycloak-craft-anything-report.md) is the
  tool's own report; `research/keycloak-screens/` has a selection of the screens.
- **Open-source JIT**: GCP JIT Groups, AWS TEAM, Teleport, Infisical, Thand, tailscale-jit, Discord Access, Common Fate
  and others were read from shallow clones, with licences noted. AGPL, BSL and Infisical `ee/` code was read for design
  only; nothing was copied. [research/jit-oss-study.md](research/jit-oss-study.md).

## What we took

| From | Idea | Here |
|---|---|---|
| Keycloak: event listeners (and their gap) | Every identity event out, reliably | The audit log is the outbox: each subscription keeps a cursor over `audit_event` ids, so an event exists only if its transaction committed and none is lost |
| Keycloak: Workflows | Lifecycle recipes (inactive → warn → disable) | *Disable inactive people* as a Landflow flow; `identity.lastSignInAt` and `GET /api/v1/people?inactiveSince=` |
| Keycloak: service accounts, client policies | Machine clients with scoped access | Client credentials with RFC 8707 resource `urn:landbright:api`, scopes from the client's `apiScopes` |
| JIT Groups, Discord Access | Access as a membership with an expiry | A grant adds `membership(source: grant, grantId, expiresAt)`; Landbright removes it |
| Teleport, Infisical | Thresholds, deny-wins, one vote per person, re-check eligibility | `decide()` and `whyNotDecide()` |
| Infisical delegated approval, spec 003 | The callback is a nudge; read back | Waits: a flow attaches its resume URL; Landbright POSTs it on votes and decisions; the flow re-reads |
| Teleport | Access from a grant can't approve | Approvers come from standing memberships only |
| TEAM, Common Fate | Per-target provisioning state; failure states | `grant_target` with `pending → provisioned / failed → revoked / revoke_failed`, `verified`, `drift`; `grant.revoke_overdue` |
| Common Fate SDK, TEAM | Break-glass, auto-approve with evidence, scheduled start | Policy `breakGlass`, `autoApprove[]` (standing-membership facts only), `startsAt` |
| Infisical | Annotations with compare-and-set | `PUT …/annotations/:key` with `If-Match: <version>` |
| jitd | Agents may ask, never decide | Requests for sponsored agents, clamped to `agentMaxDurationMinutes`; services never decide |

## Changes from spec 003

- **No Landflow change.** Spec 003 proposed a Landbright Trigger node with Standard Webhooks HMAC signatures. Landflow's
  Webhook trigger already verifies a JWT against a JWKS URL (JWT Auth credential, `keyType: jwks`). So deliveries are a
  JWT signed with the issuer's key, and Landflow holds no secret. The `Idempotency-Key` header lets Landflow's webhook
  idempotency drop repeats.
- **The audit log is the outbox** instead of separate `access_event` and `outbox_event` tables. It is already
  hash-chained and written in every transaction.
- **Waits**: the flow registers `$execution.resumeUrl` with Landbright (`POST /api/v1/requests/:id/waits`). The URL's
  origin must be an enabled subscription's.

## Design

- **Data** (migration `20261114120000_access_and_events`, row-level security forced on every new table):
  `access_bundle`, `access_request`, `access_decision` (unique per request and decider), `access_grant`,
  `grant_target`, `annotation`, `event_subscription` (cursor), `event_delivery` (unique per subscription and audit
  event). Plus `membership.grant_id`, `identity.last_sign_in_at` and `oidc_client.api_scopes`.
- **Worker** (control, under the Valkey lock `lb:worker:<tenant>`, every 2 s, off with `LANDBRIGHT_WORKER=off`):
  1. The sweeper: decision deadlines, escalation, scheduled starts, expiry notices, expiry, overdue revocations.
  2. `match`: moves each cursor and creates deliveries.
  3. `send`: up to 25 a tick, back-off 5 s × 2ⁿ⁻¹ capped at 1 h, failed after 24 h.
  4. `wake`: POSTs resume URLs on `request.vote_recorded`, `request.decided` and `request.escalated`.
- **Machine API** (`/api/v1`, bearer JWT for audience `urn:landbright:api`, scopes per route): requests (read, wait,
  annotate), grants (list, read, annotate, report a target), people (inactive, deactivate).
- **Flows** (`integrations/landflow/flows/`, installed by `e2e/landflow/install.ts`): approve a request by email;
  provision and revoke a Landflow project role; disable inactive people.

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt plumbing | PASS | oidc-provider's client credentials and resource indicators; jose for the delivery JWT; Landflow's own Webhook trigger, JWT Auth, Wait and HTTP nodes; no engine in Landbright |
| II. Default deny | PASS | `/api/v1` needs a token with a scope per route; resume URLs only at subscribed origins; every grant ends; the decision page needs a Landbright session; non-administrators see only Requests |
| III. Accountable human | PASS | Agents' requests are made by their sponsor; deciders are people |
| IV. Policy or a person approves | PASS | Votes only from signed-in people the policy names (standing memberships, not the requester or subject); a service can't decide; auto-approval and break-glass are rules a person wrote, with evidence kept |
| V. Ledger | PASS | Every change audits in its transaction; events are read from the audit log, so nothing un-committed goes out |
| VI. Standards | PASS | RFC 8707 resource indicators, RFC 9068-style JWT access tokens, RFC 8417 SET shape (`secevent+jwt`), JWKS |
| VII. N-up safe | PASS | Worker under a Valkey lock; advisory locks for request numbering and decisions; deliveries unique per event |
| VIII. Spec-driven | PASS | e2e `access.test.ts` (12 tests) against the built services with a hook server verifying the JWT; the browser story (Ido asks, the administrator approves and revokes); a live check with the real Landflow |
| IX. Local only | PASS | Mail through Mailpit; Landflow from its local image in `landbright-landflow`; Keycloak in `landbright-keycloak`; the Landflow repository untouched |

## Order of work after this slice (from the Keycloak study)

1. Required actions, an execute-actions link, and *forgot password*.
2. An account page: sign-in methods, recovery codes, sessions.
3. `acr` with per-application minimums.
4. An *Onboard* flow (required actions and birthright groups).
5. Agent clients without secrets (`private_key_jwt`, then SPIFFE), token exchange with `act`, and CIBA with Landflow as
   the channel.
