# Plan 005

[Spec](spec.md) · [Tasks](tasks.md). Built on spec 004 ([plan](../004-access-and-events/plan.md)) and its Keycloak study
([research](../004-access-and-events/research/keycloak-study.md)).

## Slice 1: access follow-ups

- **Data** (migration `20261115090000_access_follow_ups`): `access_request.extends_grant_id`,
  `access_grant.extensions`, `event_subscription.owner_client_id`. Waits keep their retry state in the annotation
  (`dueAt`, `attempts`, `nextAt`), so no table.
- **Contracts**: `ApprovalStep.allowRelayed`, `AutoApproveRule.window` (`TimeWindow`, `inWindow()`),
  `AccessPolicy.extensions`, `ExtendGrant`, `ServiceCreateRequest`, `RelayTicket`, `RelayDecision`; `patchOf()` makes
  update schemas without defaults (a PATCH that names one field used to reset the others: a live-check bug).
- **Who asks** (`plan()`): a person (for themselves or an agent they sponsor) or a service (for the agent it is, or a
  person). Eligibility is the person's, or the agent's sponsor's. Service-filed requests for people skip auto-approval.
- **Relay tickets**: a JWT signed with the issuer's key, audience `urn:landbright:relay`, `sub` the approver, `req` the
  request, `step` the step, until the deadline. `castVote()` is shared by the decision page and relayed votes; a relayed
  vote also needs the step's `allowRelayed` and the ticket's step to be the current one.
- **Token lifetimes**: `loadAccount` finds the soonest membership end; `ttl.AccessToken` and `ttl.IdToken` cap at it
  (`capToGrant`, at least 30 s). Machine API tokens keep their resource server's lifetime.
- **Flows**: *Approve a request (Slack)* (tickets, `users.lookupByEmail`, `chat.postMessage` with buttons that carry
  the ticket) and *Slack approval buttons* (the Slack app's Interactivity URL; relays the click, answers through
  `response_url`). Core nodes only; the installer adds them with `SLACK_BOT_TOKEN`, and `SLACK_API_URL` points them at a
  stand-in.

## Slice 2 and 3

See [tasks.md](tasks.md) for the order; each slice adds its design here when it lands.

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt plumbing | PASS | oidc-provider's TTL hooks, its own CIBA, device flow, PAR, DPoP, `private_key_jwt` and `registerGrantType`; Landflow's own Webhook, HTTP Request and Set nodes for Slack; jose for tickets |
| II. Default deny | PASS | Chat votes off unless a step allows them; each scope per route; subscriptions only at the application's own origins; a service-filed request for a person never auto-approves; tokens end with the grant |
| III. Accountable human | PASS | An agent's request names its sponsor (`actingFor`), who can't approve it; CIBA asks the person; an agent application is bound to one agent |
| IV. Policy or a person approves | PASS | A relayed vote is the approver's, proved by a ticket Landbright issued to them for that request and step; the flow carries it and can't choose who voted. Extensions go through the same steps |
| V. Ledger | PASS | `grant.extended`, `request.relay_tickets_issued`, relayed votes with channel, assurance, carrier and evidence, all in the audit chain |
| VI. Standards | PASS | RFC 8693 token exchange with `act`, OpenID CIBA, RFC 8628, RFC 9126 PAR, RFC 9449 DPoP, RFC 7523 `private_key_jwt`, OIDC `acr`/`acr_values` |
| VII. N-up safe | PASS | Wake-up retry state in the database; votes under the request's advisory lock |
| VIII. Spec-driven | PASS | e2e `access-follow-ups.test.ts`; unit tests for hours, update schemas; a live check of the Slack flows in the real Landflow |
| IX. Local only | PASS | Slack is a local stand-in on 127.0.0.1:57991; Landflow is the throwaway `landbright-landflow` |
