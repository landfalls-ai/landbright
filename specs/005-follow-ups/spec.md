# Spec 005: Access follow-ups, the identity plane's next pages, and agents

Status: building (2026-11-14). [Plan](plan.md) · [Tasks](tasks.md).

Spec 004 ended with two lists: what its first slice didn't build, and the Keycloak study's order of work. The user
asked for all of it. Three slices, each verified and committed on its own.

## Slice 1: access follow-ups

- **Extensions.** The holder of a live grant asks for more time. The extension is a request of its own, decided by the
  bundle's steps (and its auto-approve rules). Approved, the grant's end moves and its memberships with it; nothing is
  provisioned again. A policy allows extensions and caps how many (`extensions`).
- **Requests a service files** (`requests:create`). An agent's application asks for the agent; an intake flow asks for
  a person. A service never break-glasses, and a request it files for a person always waits for a person.
- **Votes from a chat** (`decisions:relay`). Where a step allows it (`allowRelayed`), a flow gets one ticket per
  approver from Landbright, hands each in a direct message, and relays the click with that ticket. The ticket, not the
  flow, says who voted; the vote is recorded with `assurance: chat` and the flow as `submittedBy`. Slack flows ship.
- **Tokens end with the grant.** An access token or ID token that carries a just-in-time group lives no longer than the
  soonest such membership.
- **Subscriptions an application manages itself** (`events:manage`), only at its own redirect origins.
- **Wake-ups that retry**, with the deliveries' back-off, for a day. Deliveries run in parallel across subscriptions.
- **A full policy editor**: every step (people, groups, manager, owner, sponsor, chat votes), auto-approve rules with
  hours (`window`), escalation, extensions, agents, break-glass.

## Slice 2: the identity plane (Keycloak P1)

- **Required actions** on a person, done at their next sign-in: set a new password, set up a second step, accept the
  terms. Set by an administrator or a lifecycle flow (`directory:write`); an email can say so.
- **Forgot password**: a reset link by email, rate-limited, with the same answer whether or not the address has an
  account.
- **An account page** at the identity plane: change the password; add and remove an authenticator app and passkeys;
  recovery codes (usable as the second step); see and end your sessions.
- **`acr`**: how strongly a person signed in (`urn:landbright:acr:pwd`, `:mfa`, `:phr`). An application can require a
  minimum, and `acr_values` is honored.
- **An *Onboard* flow** in Landflow on `identity.created`: birthright groups by department, required actions, a welcome
  email, through the machine API (`directory:write`).

## Slice 3: agents

- **Agent applications without secrets**: `private_key_jwt` with the agent's public keys; the application is bound to
  the agent, so it asks for access only for that agent.
- **Token exchange** (RFC 8693): an agent trades a person's token for one at another audience that says it acts for
  them (`act`).
- **CIBA with Landflow as the channel**: an agent asks a person to approve something; Landbright emits
  `ciba.requested`; a Landflow flow tells the person; the person decides on a Landbright page.
- **Device grant, PAR and DPoP** switched on.

## Out of scope

SPIFFE identities, Slack in a real workspace (the live check uses a local stand-in for Slack's Web API), consent
screens for third-party applications, SCIM.
