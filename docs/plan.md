# Landbright: the plan

Landbright is the identity provider of the land-* family: one directory for **people and agents**, the sign-in and
tokens every land-* product trusts, and the system of record for **who holds which access, until when**. It pairs
with [Landflow](../../landflow/README.md), which acts as its just-in-time (JIT) access engine (requests, approvals,
provisioning and revocation run as Landflow flows), and with [Landfall](../../landfall/README.md), which signs in with
it and can open break-glass access for an incident.

This page is the plan: what Landbright is and is not, how it connects to Landflow and Landfall, the data model, the
flows, the UI, the stack and methodology, and the order of work. [research.md](research.md) has the evidence behind
each decision: what Landflow and Landfall already offer, the HR systems, the products we borrow from, and the
standards.

Status: **wave 0 done** (2026-11-12); [roadmap.md](roadmap.md) tracks the waves.

---

## 1. What we are building, in one picture

```
             HR sources                       Requesters                         Targets
   HiBob (webhooks) · Shapes (GraphQL)   people · agents · Landfall incidents   Landflow · Landfall · GitHub · DBs · cloud
                │                                   │                                   ▲
                ▼                                   ▼                                   │ provision / revoke
   ┌──────────────────────────── Landflow (orchestration, the JIT engine) ─────────────────────────────┐
   │  HiBob Trigger ─▶ Joiner / Mover / Leaver flows      Access request flows ─▶ Approval ─▶ Provision │
   │  Landbright Trigger (request.created, grant.expiring, grant.expired, identity.*, agent.*)          │
   │  Landbright node (identities, agents, groups, grants, requests, policy) · target plugins           │
   └───────────────▲───────────────────────────────┬────────────────────────────────────────────────────┘
                   │ signed webhooks (events)       │ Landbright API (client credentials: Landflow's own identity)
                   │                                ▼
   ┌──────────────────────────── Landbright (identity, the system of record) ───────────────────────────┐
   │  Directory: people · agents · service identities · groups · HR attributes · sponsors              │
   │  Access: catalog · bundles · access policies · requests · grants (every grant expires)             │
   │  Protocols out: OIDC / OAuth 2.1 (sign-in, client credentials, token exchange with `act`),         │
   │                 SCIM 2.0 client (push users and groups), Shared Signals (CAEP) transmitter         │
   │  Agent sync with Landflow · expiry sweeper · tamper-evident audit · console + request portal        │
   └──────────────┬─────────────────────────────────────┬───────────────────────────────────────────────┘
                  │ OIDC sign-in + SCIM                  │ OIDC sign-in + SCIM
                  ▼                                      ▼
              Landflow                                Landfall
```

Three sentences carry the design:

1. **Landbright decides and remembers; Landflow acts.** Landbright owns identities, the access catalog, policy and the
   ledger of grants. Landflow owns everything that touches another system: HR intake, approvals in Slack/Teams/email,
   provisioning and revocation through its plugins, notifications. This is Apono's split (catalog + access flows +
   connectors), with the connectors and flows being ordinary Landflow plugins and workflows that people can read and
   change.
2. **Agents are first-class identities with an accountable human.** Every agent in Landflow has a twin identity in
   Landbright with a **sponsor** (a person), a risk tier, and no standing secrets. An agent acting for a person gets a
   token whose subject is the person and whose `act` claim names the agent (RFC 8693), scoped to the intersection of
   what both may do. An agent can never hold more than its person, and when the sponsor leaves, the agent stops.
3. **Nothing standing that can be just in time; every grant expires.** Permanent access is the exception that needs a
   reason. A grant has an end; Landflow revokes at the end, and Landbright enforces the end even if Landflow is down.

## 2. Who owns what

| Concern | Owner | Notes |
|---|---|---|
| Who exists (people, agents, service identities), attributes, lifecycle state | **Landbright** | HR is authoritative for HR attributes (name, department, title, manager, site, start and end dates). Landbright stores the mapping and the last value per source. |
| Sign-in (passkeys, password + MFA, upstream Google/Entra federation), sessions, tokens | **Landbright** | Landflow and Landfall become OIDC relying parties. |
| Agent definition (persona, model, tools, channels) | **Landflow** | Landbright links to it and never edits it. |
| Agent identity (sponsor, risk tier, token policy, lifecycle, credentials) | **Landbright** | Synced both ways by id; each side owns its own fields (§6.3). |
| Access catalog, bundles, access policies (eligibility, approvers, max duration) | **Landbright** | Edited in the console; versioned; every change audited. |
| The grant ledger (requested → active → expired) | **Landbright** | Event-sourced (§5.4). |
| Request intake (portal, Slack, Teams, an agent's tool call, a Landfall incident) | **Landflow** + Landbright portal | The portal and the Landbright node both create the same request object. |
| Approvals | **Landflow** (Slack, Teams, email, editor) + Landbright inbox | Policy says who approves; Landflow asks them; Landbright records the decision. |
| Provisioning and revocation in target systems | **Landflow** plugins and flows | Landbright's own targets (its groups, SCIM pushes to Landflow and Landfall) need no flow. |
| HR events (HiBob, Shapes) | **Landflow** triggers | As asked: Landflow receives HR triggers, then creates the identity and attaches access through the Landbright node. |
| Incident context for break-glass | **Landfall**, read by Landflow's Landfall Trigger | Landfall itself executes nothing (its constitution, principle V); Landflow does, under a policy a human approved. |

## 3. How Landbright connects to Landflow and Landfall

Most of the connection already exists on the Landflow and Landfall side. The first two items need **no code in
Landflow or Landfall** at all.

### 3.1 Sign-in (OIDC), no code in Landflow or Landfall

- **Landflow** already signs in with any OIDC provider: `LANDFLOW_OIDC_ISSUER`, `LANDFLOW_OIDC_CLIENT_ID`,
  `LANDFLOW_OIDC_CLIENT_SECRET`, roles from a claim through `LANDFLOW_OIDC_ROLE_MAP`
  (`landflow/docs/features/authentication.md`). Landbright registers Landflow as a client and emits a `roles` claim
  from group membership.
- **Landfall** has per-tenant OIDC SSO configuration (feature 001). Landbright is configured there as the org's IdP.
- Landflow's MCP gateway already accepts a second issuer next to Landflow's own tokens ("Two issuers on a route",
  `landflow/docs/protocol.md` §15.4). Landbright is that issuer, so agents holding Landbright tokens reach Landflow's
  MCP tools without a token swap.

### 3.2 Provisioning (SCIM 2.0 push), no code in Landflow or Landfall

Landflow and Landfall are both SCIM 2.0 servers. Landbright is the SCIM **client** that Okta or Entra would otherwise
be: it creates, updates and deactivates users and pushes groups.

- `LANDFLOW_SCIM_GROUP_MAP` turns Landbright groups into Landflow roles and team-project memberships
  (`Data Team=project:Data:editor`). So **Landflow is the first JIT target with zero Landflow changes**: "editor on the
  Data project for 4 hours" is a time-bound group membership that Landbright pushes and removes.
- Deactivating a person (a leaver) pushes `active: false`, which signs them out of Landflow everywhere at once.

### 3.3 The `landbright` plugin for Landflow (new, in the Landflow repo)

A TypeScript-SDK plugin at `landflow/plugins/landbright`, laid out like `plugins/landfall` (README, `src/`, a fake
Landbright for tests, `pnpm plugin:landbright`), following Landflow's conventions to the letter (docs page, reference,
history row).

| Node | Resource → operations |
|---|---|
| **Landbright** (`landbright.landbright`, usable as an AI tool) | **Identity** → Create, Get, Find, Update, Deactivate, Reactivate · **Agent** → Register, Get, Set Sponsor, Suspend, Resume · **Group** → Add Member, Remove Member, Get Members · **Request** → Create, Get, Decide (approve / deny), Comment · **Grant** → Create, Get, Get Many (active), Extend, Revoke, Record Provisioned, Record Failed · **Policy** → Evaluate (may *subject* get *bundle* for *duration*? → decision, approvers, reasons) |
| **Landbright Trigger** (`landbright.landbrightTrigger`, app webhook trigger, `landflow/docs/protocol.md` §12) | `request.created`, `request.decided`, `grant.activated`, `grant.expiring` (default 15 min before), `grant.expired`, `grant.revoked`, `identity.created`, `identity.updated`, `identity.deactivated`, `agent.registered`, `agent.suspended`, `sponsor.left`. On publish the plugin registers a webhook subscription at Landbright (`checkExists` / `create` / `delete`); deliveries are signed (Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`), and `webhook-id` is the idempotency key. |

Credential **Landbright API** (`landbrightApi`): base URL, client ID, client secret or private key. The plugin uses the
OAuth client-credentials grant, so Landflow calls Landbright **as its own service identity**, with scopes limited to
what its flows need (`identities:write`, `grants:write`, …), and every change it makes is audited as "Landflow (service)
acting for request REQ-128".

### 3.4 The `hris` plugin for Landflow (new, in the Landflow repo)

HR sources, one plugin like `plugins/productivity` groups several services. It's TypeScript unless the Shapes client
argues for another language.

| Node | What it does |
|---|---|
| **HiBob Trigger** (app webhook, set up by hand like the Slack Trigger) | Bob has no API to create webhook subscriptions, so publishing checks the credential and the Publish menu shows the Request URL to paste into Bob. Verifies `Bob-Signature` (HMAC-SHA512 over the raw body, base64) and answers Bob's ping. Emits `employee.joined`, `employee.updated`, `employee.left`, `employee.inactivated`, `employee.access.revoked.immediately`, … Bob's payload is thin (`data.employeeId`), so **Fetch Employee** is on by default and adds the full record. Idempotency key: type + employee id + `triggeredAt`. |
| **HiBob** (action) | People → Get (`POST /v1/people/{id}`), Search (`POST /v1/people/search`, `showInactive: true` for leavers). Honours Bob's limits (search 50/min, read 100/min) with `Retry-After`. |
| **Shapes Trigger** (polling, §8 of the protocol) | Shapes (formerly DreamTeam) has a GraphQL API with per-user tokens: a 15-minute access token and a 7-day refresh token that rotates on every use. The trigger polls for changed employees and keeps the rotated refresh token in node static data. Shapes Automations can also call a URL on a field change, but the payload isn't documented and isn't signed, so it's optional and only nudges a poll. **Blocked on the vendor's schema** (§11). |
| **Shapes** (action) | Employees → Get, Get Many. |

Every HR node outputs one **normalized worker record**, so the joiner/mover/leaver flows don't care which HR system
they came from:

```ts
interface HrWorker {
  source: 'hibob' | 'shapes';
  sourceId: string;
  email: string;
  givenName: string; familyName: string; displayName: string;
  department?: string; title?: string; site?: string;
  manager?: { sourceId: string; email?: string };
  startDate?: string; endDate?: string;
  status: 'pre-hire' | 'active' | 'leave' | 'terminated';
  raw: unknown;                            // the source's own record, for mappings we didn't foresee
}
```

### 3.5 Changes Landflow itself needs (to be filed as Landflow specs)

Small and separable. Each would be a spec in `landflow/docs/specs/` and ship with Landflow's own docs rules.

| # | Change | Why | Until it ships |
|---|---|---|---|
| L1 | An **Approval** node for workflows (Ask In: Slack, Teams, Email, Landbright inbox; approvers, timeout, outputs *approved* / *denied* / *timed out*), reusing the AI Agent's tool-approval machinery (`POST /api/executions/:id/approvals`, Slack buttons, signed email links) | JIT flows need a person's decision mid-flow; today only agent tool calls ask for one | A **Wait** node on `$execution.resumeUrl`, which Landbright's inbox calls when someone decides |
| L2 | An **`agents:read`** API key scope and agent lifecycle events (created, published, unpublished, deleted) | Agent sync without an admin key | Sync with an `admin`-scoped key by polling `GET /api/agents` |
| L3 | An **identity link** on agents: `identity?: { issuer, subject, sponsor? }`, shown on the agent page ("Identity: Landbright · sponsor Dana Levi") | The agent page and the roster show who is accountable | The link lives only in Landbright |
| L4 | MCP grant subject kind **`agent`** (`landflow/docs/protocol.md` §15.5: today `user`, `group`, `project`, `role`, `token`) | Tool grants that name an agent identity, not a person | Grant to a SCIM group that holds only that agent |
| L5 | Agent runs **exchange tokens at Landbright**: a run started by a person gets `sub` = person, `act.sub` = agent, and calls tools with it | Delegation that tools and audit logs can read | Agents use the project's credentials, as today |

### 3.6 Landfall

- OIDC sign-in and SCIM provisioning per org (§3.1, §3.2).
- **Break-glass on an incident**: the Landfall Trigger in Landflow (*New Incident*, sev1/sev2) starts a flow that asks
  Landbright to evaluate the *incident responder* policy for the room's members and grants the pre-approved bundles
  for the incident's duration. *Incident Ended* revokes them. The flow records "Access granted: prod-db-read for
  Dana, until the room closes" in the room with **Add Note**. Landfall executes nothing itself, which keeps its
  "suggest only" principle; the policy that pre-approves this is one a human approved in Landbright.

## 4. The flows

### 4.1 Joiner, mover, leaver (from HR)

Shipped as **Landflow team templates** (`landflow/docs/templates.md`), so a customer starts from a working flow and
edits it in the canvas.

```
Joiner   HiBob Trigger (employee.joined | employee.created with a future start date)
          → Map worker (department → birthright bundles, from a Landbright data mapping)
          → Landbright: Identity → Create (status pre-hire until the start date; email, manager, department…)
          → Landbright: Group → Add Member (birthright groups: "All staff", "Dept: Data")   ← standing, the only exception
          → Landbright: Grant → Create for each birthright bundle that needs provisioning elsewhere
          → Slack: welcome DM to the manager with the access the person will have on day one

Mover    HiBob Trigger (employee.updated, fieldUpdates ∋ department | title | manager | site)
          → Landbright: Identity → Update
          → Policy → Evaluate the person's existing grants against the new attributes
          → grants that no longer fit: mark "under review"; the manager decides keep / revoke within N days (Approval)

Leaver   HiBob Trigger (employee.left | employee.inactivated)               scheduled: end of the last day
         HiBob Trigger (employee.access.revoked.immediately)                  urgent: now
          → Landbright: Identity → Deactivate   (sessions and tokens revoked, SCIM active:false to Landflow and Landfall,
                                                 CAEP session-revoked to receivers, every grant revoked)
          → for each agent the person sponsors: Agent → Suspend and ask the person's manager to pick a new sponsor
          → target revocations run through the same revoke flows as expiring grants
```

### 4.2 Just-in-time access (the Apono-style flow)

```
Request   portal / Slack "/access prod-db-read 4h INC-42" / an agent's "Request access" tool / Landfall incident
            → Landbright creates REQ-128 (requester, subject, bundle, duration, reason, ticket or incident)
            → Policy: eligible? auto-approve? which approvers? max duration?
            → request.created → Landflow
Approve   Landflow: Approval node (Slack buttons to the approvers the policy named: manager from HR, resource owner,
            on-call from Landfall) → Landbright: Request → Decide
Provision Landflow: the bundle's provisioning flow (one per target: Postgres role, GitHub team, Google group,
            Landflow project via SCIM group, AWS permission set…) → Grant → Record Provisioned
Use       the grant is active until expiresAt; "Extend" is a new request on the same grant
Expire    Landbright emits grant.expiring (T-15 min, the requester can ask to extend) and grant.expired
            → Landflow: the bundle's revoke flow → Grant → Record Revoked
Backstop  Landbright's sweeper revokes its own side at expiresAt whatever happens (groups, SCIM, tokens) and keeps
            re-sending grant.expired until a revoke is recorded; a grant past its end that is still not revoked
            downstream raises an alert in the console and, optionally, a Landfall incident (its multi-source triggers)
```

**Access policy** (what Apono calls an access flow), per bundle or per catalog folder:

| Field | Example |
|---|---|
| Eligible requesters | groups, HR attributes (`department = Data`), identity kind (`person`, `agent`) |
| Max duration, default duration | 8 h, 2 h; agents: 15 min max |
| Approvers, in order | manager (from HR), bundle owner; agents: always the sponsor |
| Auto-approve when | the requester is on call **and** a sev1/sev2 Landfall incident is open on a matching service |
| Requires | a reason; a ticket or incident id |
| Never | an agent approves a request; a person approves their own |

### 4.3 Agentic identity

- **Kinds**: `person`, `agent`, `service` (a workload that isn't an AI agent: CI, Landflow itself).
- **Blueprints** (after Microsoft Entra Agent ID): an agent identity is created from a blueprint that holds the token
  policy, allowed scopes and risk tier for a class of agents. A Landflow persona template or team template maps to a
  blueprint, so every agent made from "SRE investigator" starts with the same limits. Suspending a blueprint suspends
  every agent made from it.
- **An agent identity** has: a sponsor (required), a home team or Landflow project, a purpose, a risk tier
  (`low` / `elevated` / `privileged`), a runtime (`landflow`, `kagent`, `claude-code`, `external`), the link to its
  definition (Landflow instance + agent id + published version), allowed audiences and scopes, a max token lifetime,
  and the people it may act for (`anyone in its project`, `its sponsor only`, `nobody`).
- **No standing secrets.** An agent gets short-lived tokens:
  - *acting alone* (schedules, workflows): client credentials with `private_key_jwt` (the key held by Landflow, sealed
    like its other credentials) → `sub` = agent;
  - *acting for a person* (chat, Slack): token exchange (RFC 8693), `subject_token` = the person's token,
    `actor_token` = the agent's → `sub` = person, `act` = `{ sub: agent }`, scopes = the intersection of the person's
    and the agent's;
  - *reaching another app's MCP server or API* (Landfall's hosted MCP connector, a SaaS tool): Landbright issues an
    **ID-JAG** (Identity Assertion JWT Authorization Grant, IETF draft -06, Okta's "Cross App Access"), which the
    app's authorization server swaps for its own access token. This is the MCP authorization spec's
    Enterprise-Managed Authorization extension (stable at revision 2026-07-28): the IdP applies the admin's policy, so
    nobody clicks through a consent screen per app;
  - later, on kagent: a workload attestation (SPIFFE) in place of the key.
- **MCP clients register by URL.** Landbright accepts Client ID Metadata Documents (the client ID is an HTTPS URL),
  as the MCP authorization spec (2026-07-28) prefers. It doesn't support dynamic client registration, which that
  revision deprecates. Every token is audience-bound with RFC 8707 `resource`.
- **Tool calls are classified** (after Apono's Agent Privilege Guard): read, create, update, delete, admin. Policy can
  say "this agent may read freely, needs its sponsor for update, never delete", which maps onto Landflow's existing
  per-grant `approval: always | destructive | never` (`landflow/docs/protocol.md` §15.5).
- **Agents request access like people do**, through the Landbright node as an AI tool ("Request access"), and the
  policy treats them more strictly: sponsor approval always, short maximums, no auto-approval for `privileged`.
- **The kill switch**: suspending an agent revokes its tokens, ends its grants and emits CAEP `session-revoked` and
  `credential-change`. Landflow, as an SSF receiver later, unpublishes or pauses it.

## 5. The data model (first cut)

### 5.1 Directory

```
Tenant           id, slug, name                                  (multi-tenant boundary from day one; one tenant to start)
Identity         id (idn_…), tenant, kind person|agent|service, status pre-hire|active|suspended|deactivated,
                 displayName, email?, avatar, createdAt, updatedAt
PersonProfile    identity, givenName, familyName, department, title, site, managerId?, startDate?, endDate?
AgentProfile     identity, sponsorId (Identity person), homeProject?, purpose, riskTier, runtime,
                 maxTokenTtl, actFor any|sponsor|none, allowedAudiences[], allowedScopes[]
SourceLink       identity, source hibob|shapes|landflow|scim, sourceId, lastSeenAt, lastValues (json)
Group            id, tenant, name, kind static|birthright|jit, owner
Membership       group, identity, source manual|hr|grant, grantId?, expiresAt?
Authenticator    identity, kind passkey|password|totp|upstream, …
Client           OIDC/OAuth client: Landflow, Landfall, the Landflow service identity, each agent's client
```

### 5.2 Access catalog

```
Target           id, kind landbright-group|scim-app|landflow-flow, name, owner, health
Entitlement      id, target, name ("Data:editor", "pg role ro on prod", "GitHub team sre")
Bundle           id, name, entitlements[], provisioningFlow?, revokeFlow?, owner, policyId
Policy           id, version, eligibility, maxDuration, defaultDuration, approvers[], autoApprove (CEL), requires[]
```

### 5.3 Requests and grants

```
Request          id, number (human-readable: "ACME REQ-128", the Landfall `{org} {number}` rule), requester, subject,
                 bundle, duration, reason, ticket?, incident?, status, decisions[]
Grant            id, request?, subject, bundle, startsAt, expiresAt, status, provisionedTargets[], revokedTargets[]
```

### 5.4 The ledger is event-sourced

Grants and requests are projections of an append-only event log (`request.created`, `request.approved`,
`grant.activated`, `grant.provisioned{target}`, `grant.expiring`, `grant.expired`, `grant.revoked{target}`, …),
following Landfall's principle IV. That gives "who had access to prod on 3 October at 14:00" by replay, and the
access-review report for free. The audit log is hash-chained and tamper-evident (Landfall's pattern). Outbound
events go through a transactional outbox, so a webhook to Landflow is sent if and only if the change committed.

## 6. The UI: aligned with Landflow and Landfall

### 6.1 One design language

Landflow's tokens are already "after the Landfall design system" (`landflow/apps/web/src/app/globals.css`): a
monochrome editorial palette, near-black accent on white, brick red for danger, forest green for good, amber for
caution, light by default with dark following the OS. Landbright uses **the same tokens by name** (`--bg`, `--sf`,
`--t1`…`--t3`, `--ac`, `--rd`, `--gn`, `--warn`, `--viz-*`), Geist, lucide icons, and the same primitives (button,
badge, empty state, page header, copy button, JSON view, popover). Someone moving from Landflow to Landbright should
not notice a seam.

To stop the copies drifting, the first slice puts the tokens in a small package (`@land/tokens`: one CSS file plus a
Tailwind 4 `@theme` block) that Landbright consumes. Landflow and Landfall can adopt it later; until then a check in
Landbright's CI diffs our copy against Landflow's `globals.css`.

### 6.2 The console's shape, after Landflow's shell

Landflow's sidebar groups its pages (`Build`: Home, Workflows, Templates, Agents, Executions…; `Extend`: Plugins,
Marketplace…). Landbright does the same:

| Group | Pages |
|---|---|
| **Directory** | Home · People · Agents · Groups |
| **Access** | Requests (inbox: mine, to approve) · Grants (active, expiring, the timeline) · Catalog (targets, bundles) · Policies |
| **Connect** | Sources (HiBob, Shapes, Landflow) · Applications (OIDC clients, SCIM targets) · Webhooks |
| **Govern** | Audit log · Access reviews · Settings |

- **Home** answers "what needs me?" in the editorial style of Landflow's Home: requests waiting for you, grants
  expiring today, joiners and leavers this week, agents without a sponsor, grants past their end that are not revoked
  downstream.
- **Agents** is Landflow's roster, from the identity side: the same faces and avatars (the plugin reads them from
  Landflow), with sponsor, risk tier, runtime, live grants and "last token issued". An agent card links to its page in
  Landflow, and Landflow's agent page links back (L3).
- **Grants** has a timeline view (who held what, when), the same mental model as Landflow's Run Trace story view.
- **Sources** and **Applications** follow Landfall's integrations wizard (features 018/019): connect, test with a live
  health check, show the last sync and its errors.
- **Request portal** (`/request`) is a single-purpose page for people who never open the console: pick a bundle,
  duration and reason, see your requests and live grants. It's the same request object Slack and agents create.
- **Identifiers** follow Landfall's rule: people see `ACME REQ-128`, never a UUID.
- **Sign-in pages** are server-rendered with minimal JavaScript and a strict CSP, in the same tokens: passkey first,
  then password + TOTP, then "Continue with Google / Microsoft" when upstream federation is on.
- **⌘K** works as in Landflow (cmdk): jump to a person, an agent or a request, or "Request access to…".

## 7. Stack

Landbright is security infrastructure with a public protocol surface. It takes **Landfall's engineering foundations**
for the service and **Landflow's conventions** for everything that lives in Landflow.

| Layer | Choice | Why, and the alignment |
|---|---|---|
| Monorepo | pnpm 10.28 + Nx, Node 22, TypeScript 5.9 | Landfall's layout (`apps/`, `libs/`); same package manager pin as both repos |
| Services | **NestJS 11**: `apps/idp` (protocol plane: OIDC/OAuth, sign-in pages, JWKS, token exchange) and `apps/control` (console API, catalog, requests, grants, sync, webhooks, sweeper) | Landfall's principle VI: Guards (default deny), Interceptors (audit, tracing), Pipes (validation), `@nestjs/terminus`, `@nestjs/throttler`, `@nestjs/swagger`, `@nestjs/cqrs` for the event-sourced ledger. The protocol plane stays small and separately deployable. |
| OIDC / OAuth engine | **Adopt** [`oidc-provider`](https://github.com/panva/node-oidc-provider) (OpenID Certified), mounted in `apps/idp`, with token exchange and ID-JAG as registered custom grants | Landfall principle I: adopt, don't build, protocol plumbing. **Keycloak 26.8** is a close runner-up (research.md §6): it now has SCIM, native token exchange, and delegation with `act` in preview. It stays the fallback, and the choice is open question 4. |
| Tokens and keys | `jose` (as Landflow uses); signing keys in **OpenBao** (already in Landflow's infra stack), rotated with two published keys | |
| Authorization | Postgres ledger first; **OpenFGA** (CNCF, Landfall already runs it) as the check projection from wave 6, with time-bound tuples as CEL conditions; an **AuthZEN** evaluation endpoint for apps | |
| Storage | PostgreSQL 16 with row-level security per tenant (Landfall), Prisma (Landfall's `libs/persistence`), Valkey (sessions, rate limits, the sweeper's leader lock) | |
| Events | Transactional outbox → signed webhooks (Standard Webhooks) and an SSF/CAEP stream | No bus needed until fan-out needs one; NATS JetStream (Landfall) is the upgrade path |
| Console | React 19 + Vite, Tailwind 4 with the shared tokens, Radix primitives, lucide, Geist, TanStack Query, zustand, sonner, cmdk | Landfall's web stack (React + Vite + Radix + TanStack Query + zustand) with Landflow's look (Tailwind 4 tokens, lucide, Geist, sonner, cmdk) |
| Contracts | zod schemas → OpenAPI 3.1 (`GET /api/openapi.json`, like Landflow), SCIM, the webhook event schemas, all in `libs/contracts` and authoritative | Landfall principle VII |
| Observability | OpenTelemetry traces, metrics, logs, after Landflow's contract (`landflow/docs/observability.md`): `landbright.*` attributes, a trace across Landflow → Landbright (W3C `traceparent` on the plugin's calls) | |
| Landflow plugins | `@landflow/sdk` (TypeScript), vitest, a fake Landbright server like `fake-landfall` | Landflow's conventions, in the Landflow repo |
| Tests | Vitest (unit and route), Testcontainers (Postgres, Valkey, OpenBao, OpenFGA), Playwright (console, sign-in, portal), the **OpenID Foundation conformance suite** in Docker for the OIDC profiles, a SCIM compliance run against Landflow and Landfall, and **scenarios as evals** for policy and agent behaviour | |
| Runtime | Docker Compose for dev (`landbright-*` projects), Kubernetes on OrbStack (namespace `landbright-dev`) | Landflow's "local only" rule, copied verbatim into `CLAUDE.md` |

**Why not Next.js like Landflow?** Landflow is one app whose UI and API change together. Landbright's protocol plane
must stay small, hardened, separately scaled and free of UI code, and NestJS's guards and interceptors give default
deny and audit-by-default at the framework level. The console still looks and feels like Landflow (§6). The
alternative, a Next.js app with `oidc-provider` in a custom server, is in research.md §6 with its tradeoffs.

## 8. Methodology

Landbright combines the two methods its siblings use.

1. **Spec-driven, from Landfall.** `.specify/` with spec-kit: specify → clarify → plan → **senior design review**
   (a more capable model checks the plan's claims against the live Landflow and Landfall source, not just its own
   consistency) → tasks → analyze → implement. One folder per feature: `specs/NNN-name/` with `spec.md`, `plan.md`,
   `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`.
2. **A constitution** (`.specify/memory/constitution.md`), ratified before the first feature:
   - I. **Adopt protocol plumbing, build the identity core.** Build: the agentic identity model, the access ledger,
     the policy model, the Landflow integration. Adopt: OIDC/OAuth engine, authorization engine, key storage.
   - II. **Default deny, least privilege, zero standing privilege as the goal.** Every grant has an end; a standing
     grant needs an owner and a reason, and is reviewed.
   - III. **Every identity has an accountable human.** No agent without a sponsor; a sponsor who leaves suspends their
     agents until a new sponsor is named.
   - IV. **Policy or a person approves; an agent never does.** No one approves their own request; agents can request,
     never decide.
   - V. **Event-sourced ledger, tamper-evident audit** (Landfall IV).
   - VI. **Standards on the wire.** OIDC, OAuth 2.1, RFC 8693, SCIM 2.0, SSF/CAEP, AuthZEN, Standard Webhooks.
     Nothing proprietary where a standard exists.
   - VII. **Stateless, multi-tenant boundary designed in, N-up safe** (Landfall III).
   - VIII. **Spec-driven and test-backed; conformance suites are tests** (Landfall VII).
   - IX. **Local only** (Landflow): OrbStack, no cloud, development credentials only.
3. **Docs move with the code, from Landflow.** `docs/README.md` (index + feature map), a page per feature,
   `docs/reference/` (API, configuration), `limitations.md`, `roadmap.md`, `history.md` with a row per commit.
4. **Waves, from Landflow.** Work ships in waves (§9). Each wave ends with every suite green, a clean type check, a
   live check on the local stack and in the browser, and its bugs fixed in the same wave.
5. **Integration definition of done, from Landfall (constitution v1.2.0).** Every integration (HiBob, Shapes,
   Landflow, Landfall, each JIT target) ships with a setup guide with screenshots, is reachable by agents through
   discovery (the Landbright node is usable as an AI tool and Landflow exposes it over MCP), can trigger a flow, and
   updates the one architecture page.

## 9. Waves

Each wave lists its **first slice**: the smallest end-to-end thing that proves it.

| Wave | Builds | First slice |
|---|---|---|
| **0. Foundations** | Repo (Nx, NestJS `idp` + `control`, console shell with the shared tokens), constitution, compose infra (Postgres, Valkey, Mailpit, OpenBao), OTel, the verify gate, docs skeleton | `pnpm dev:up && pnpm serve` brings up a console that shows the Landflow-styled shell and a health page |
| **1. Identity core and sign-in** | People, agents (manual), groups, OIDC provider (authorization code + PKCE, refresh, client credentials, discovery, JWKS), passkeys + password + TOTP, console Directory pages, Applications | **Sign into Landflow with Landbright**: a person created in the console signs into Landflow over OIDC and lands with the role their group maps to. No Landflow code changed. |
| **2. Provisioning out** | SCIM client with retries and reconciliation, targets Landflow and Landfall, deactivation propagation, group → project mapping | Deactivating a person in Landbright signs them out of Landflow within seconds |
| **3. Landflow plugins and HR lifecycle** | `landbright` plugin (node, trigger, credential, fake), `hris` plugin (HiBob trigger and node; Shapes once unblocked), normalized worker, joiner / mover / leaver team templates | A signed HiBob `employee.joined` delivery creates the person in Landbright, adds birthright groups, and they can sign into Landflow on their start date |
| **4. Just-in-time access** | Catalog, bundles, policies, requests, grants and the ledger, the sweeper, the request portal, the Requests and Grants pages, provisioning and revoke flow templates, Landflow spec L1 (Approval node) | "Editor on the Landflow *Data* project for 2 hours": requested in the portal, approved in Slack through a Landflow flow, pushed as a SCIM group, removed at expiry, every step on the grant's timeline |
| **5. Agentic identity** | Agent sync with Landflow (reconciler, L2, L3), blueprints, sponsors and the sponsor-left cascade, client credentials with `private_key_jwt`, token exchange with `act`, ID-JAG for cross-app access, Client ID Metadata Documents, tool-call classes, the agent "Request access" tool, kill switch, CAEP transmitter, Landflow specs L4 and L5 | A Landflow agent appears in Landbright with its face and a sponsor; in a Slack chat it asks for read access to a database for 15 minutes; the sponsor approves; the tool call carries `sub` = person, `act` = agent; the access ends on time |
| **6. Policy, reviews, signals** | OpenFGA projection, AuthZEN endpoint, access reviews (an agent drafts recommendations from usage, people decide), Landfall break-glass template, unused-grant suggestions to Landflow's second brain | A sev1 Landfall incident gives the on-call responder the incident bundle until the room closes, with a note in the room |

## 10. Risks

| Risk | What we do |
|---|---|
| Building an IdP is a security product; mistakes are breaches | Adopt a certified OIDC engine, run the OpenID conformance suite in CI, keep the protocol plane small, external review before any non-local use |
| Landbright and Landflow disagree about a grant (flow failed midway, Landflow down) | The ledger records per-target state; the sweeper and a reconciler re-send until each target records a result; stuck grants surface on Home |
| HR timing: Bob fires lifecycle events at midnight in the site's time zone, not when HR enters the change | Pre-hire identities from `employee.created` with a future start date; the leaver path also handles `employee.access.revoked.immediately` |
| Shapes has no public API reference, and its webhooks are unsigned | Polling with a rotating refresh token; ask Shapes for the GraphQL schema (§11); keep it behind the normalized worker |
| Rotating refresh tokens must be written back after every Shapes poll | Node static data holds the current token. If static data proves unsafe for a secret, this needs a Landflow change: credentials that a plugin can update. |
| Agent delegation semantics are still moving in the standards (ID-JAG is draft -06; IETF WIMSE's AI identity draft is -01) | Keep `act` chains, ID-JAG and scopes behind one module; re-check the drafts and the MCP authorization revision at the start of each wave |
| Two parents' methods conflict (build vs adopt, Next vs Nest) | Decided in §7 and §8; a deviation goes in the constitution's record, like Landfall's |

## 11. Open questions for you

1. **Name and home**: `landbright`, at `~/WorkSpace/landbright`, a private repo under `landfalls-ai`?
2. **Tenancy**: one tenant per deployment to start, with the multi-tenant boundary designed in (recommended), or
   multi-tenant SaaS from wave 1?
3. **Shapes**: can you get API access and the GraphQL schema ("DreamTeam-V1" on Apollo Studio) plus the Automations
   webhook format from Shapes? Wave 3 builds HiBob first either way.
4. **Engine**: `oidc-provider` embedded in NestJS (recommended), or Keycloak as the engine with Landbright as its
   control plane?
5. **Landflow changes L1–L5**: shall I write them up as specs in `landflow/docs/specs/`?
6. **First JIT targets** after Landflow itself: GitHub teams, Postgres roles (the databases plugin), Google groups,
   AWS permission sets (through LocalStack only)?
