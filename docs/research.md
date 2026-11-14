# Landbright: research

The evidence behind [plan.md](plan.md): what Landflow and Landfall already offer an identity provider, the HR systems
we read from, the products we borrow from, the standards, and the build-or-adopt choice. Gathered 2026-11-12 from the
two sibling repositories (paths are relative to `~/WorkSpace`) and from vendor and standards pages (URLs inline).
**[secondary]** marks a fact from trade press, and **[unconfirmed]** one we could not check against a primary source.

---

## 1. Landflow: what an IdP can plug into

Landflow is a low-code workflow platform modelled on n8n, where every node is a plugin
(`landflow/README.md`). It is a Next.js 16 app (`apps/web`) with an engine, protocol, SDKs and CLI in `packages/`,
and plugins in TypeScript, Python and Go.

### 1.1 Identity surfaces that already exist

| Surface | What it does | Source | Use for Landbright |
|---|---|---|---|
| OIDC sign-in | Authorization code + PKCE; users created just in time; roles from a claim (`LANDFLOW_OIDC_ROLE_MAP`, dotted claim paths) applied at every sign-in | `landflow/docs/features/authentication.md` | Landbright as Landflow's IdP, with **no Landflow code** |
| SAML 2.0 | Signed and encrypted assertions, role and group→project maps, single logout | same | Alternative to OIDC; not needed |
| **SCIM 2.0 server** | `/scim/v2` Users and Groups with filters and PATCH; `active: false` signs the user out everywhere; `LANDFLOW_SCIM_GROUP_MAP` turns groups into roles and team-project memberships (`Data Team=project:Data:editor`) | same | Landbright pushes people and groups; **time-bound group membership is JIT access to Landflow** with no Landflow change |
| Projects and roles | owner / admin / member; per-project admin / editor / viewer | same | The first JIT entitlements |
| API keys | Scopes `workflows:*`, `executions:*`, `run`, `audit:read`, `admin`, `scim` | same | No `agents:read` scope today (a gap, plan L2) |
| MCP tokens and gateway | Landflow-issued ES256 JWTs; agentgateway in front of every plugin's MCP endpoint; **a second issuer (the identity provider's) accepted on each route** | `landflow/docs/protocol.md` §15.4 | Landbright-issued tokens reach Landflow's MCP tools directly |
| MCP tool grants | Subject `user`, `group`, `project`, `role` or `token`; per-grant credential binding; `approval: always / destructive / never`; no implicit grants | `landflow/docs/protocol.md` §15.5 | No `agent` subject (a gap, plan L4) |
| Audit and governance | Audit log with SIEM streaming; four-eyes publishing; per-project allow-lists | `landflow/docs/features/audit-and-governance.md` | The model for Landbright's audit and approvals |

### 1.2 Orchestration surfaces (the JIT engine)

| Surface | What it does | Source |
|---|---|---|
| App webhook triggers | A trigger registers its own webhook at the service when the workflow is published (`checkExists` / `create` / `delete`), verifies the signature over the raw body, returns items + an idempotency key | `landflow/docs/protocol.md` §12 |
| Polling triggers | Poll state per node, baseline on first poll | `landflow/docs/protocol.md` §8 |
| Wait node | Interval, date, webhook resume (`$execution.resumeUrl`), form; long waits suspend the run durably | `landflow/docs/features/engine.md` |
| Approvals | Only for **AI tool calls**: editor, Slack buttons, signed email links (`POST /api/executions/:id/approvals`); Teams cards only for standalone agents | `landflow/docs/features/ai.md`, `landflow/docs/agents.md` |
| Pausing a run | Only host (in-process) nodes can call `ctx.putExecutionToWait`; a remote plugin node can't wait | `landflow/docs/protocol.md` §10 |
| Signature helpers | GitHub, Stripe, Slack, plain HMAC-SHA256; no Standard Webhooks helper | `landflow/packages/sdk/src/signatures.ts` |
| Team templates | A team, its agents and its flow saved and recreated with fresh ids and credentials | `landflow/docs/templates.md` |
| Integration plugins | messaging (Slack, Teams…), productivity, google-workspace, databases, github, browser, landfall, triage | `landflow/docs/features/integrations.md` |

**Gap:** there is no approval step for a plain workflow, only for an AI Agent's tool calls (Landflow's own roadmap
lists it as remaining). A JIT flow needs one (plan L1), and it must be a host node, because remote plugins can't pause
a run. Until then a Wait node on `$execution.resumeUrl` works, but that URL is public and unauthenticated, so Landbright
only nudges it and the flow re-reads the decision ([spec 003 plan](../specs/003-access-requests-and-approvals/plan.md),
checked against the source on 12 November 2026).

### 1.3 Agents

Standalone agents (`landflow/docs/agents.md`) have a persona, model, skills, tools, channels (Slack, Teams, Telegram),
schedules, published versions, and can deploy to kagent. Their data shape (`landflow/apps/web/src/lib/shared/agents.ts`,
`Agent`, `AgentSummary`) has **no owner, no sponsor and no external identity**. An agent's tools use the credentials
its project owns or was shared, so agents have no identity of their own. API: `GET/POST /api/agents`,
`GET/PUT/DELETE /api/agents/:id`, `POST/DELETE /api/agents/:id/publish`. Agent changes also stream on
`GET /api/events` (`channel: 'agent'`).

### 1.4 How Landflow is built and run

- **Conventions** (`landflow/CLAUDE.md`, `landflow/docs/development.md`): migrations appended in one file; routes via
  `handler()`/`json()`/`error()`/`parseBody()` + zod; access rules in one policy file; tests next to their package;
  comments say why.
- **Docs move with the code**: a feature page, `reference/`, `limitations.md`, `roadmap.md`, and a `history.md` row
  per commit. Unbuilt features are specs in `docs/specs/NN-name.md`.
- **Waves**: each ends with every suite green, a clean type check, a live check on the local stack and in the
  browser, and the bugs found fixed in the same wave (`landflow/docs/history.md`).
- **Local only**: OrbStack Docker and Kubernetes (`landflow-dev`), no cloud, LocalStack for AWS, development
  credentials only.
- **UI**: Next.js 16, React 19, Tailwind 4 with CSS-variable tokens, Geist, lucide, sonner, cmdk, zustand, xyflow
  (`landflow/apps/web/package.json`). The tokens are "after the Landfall design system": monochrome editorial
  palette, near-black accent, brick red / forest green / amber, light by default, dark from the OS
  (`landflow/apps/web/src/app/globals.css`). The sidebar groups pages (`Build`, `Extend`)
  (`landflow/apps/web/src/components/shell/sidebar.tsx`).
- **The Landfall plugin** (`landflow/plugins/landfall/README.md`) is the template for a land-* bridge plugin: one
  action node usable as an AI tool, one trigger, typed credentials, errors with the service's message and a hint, a
  fake server for offline tests.

## 2. Landfall: what it expects of an IdP, and how it is built

Landfall is the incident-response war room (`landfall/README.md`).

- **Identity today**: Keycloak 26 (single realm, Organizations, per-org IdP brokering), OpenFGA for fine-grained
  authorization behind NestJS Guards, per-tenant OIDC SSO and SCIM 2.0 provisioning with prompt deprovisioning
  (`landfall/specs/001-base-infrastructure/research.md` §2–4). Landbright plugs in as the org's OIDC IdP and SCIM
  client.
- **Stack**: pnpm + Nx monorepo, NestJS 11 services, React + Vite web (Radix, TanStack Query, zustand), PostgreSQL 16
  with row-level security, Valkey, NATS JetStream, OpenTelemetry (`landfall/README.md`, `landfall/apps/web/package.json`).
- **Methodology**: spec-driven development with spec-kit (`/speckit.specify` → clarify → plan → **mandatory senior
  design review** → tasks → analyze → implement), one `specs/NNN-name/` folder per feature with spec, plan, research,
  data model, contracts, quickstart and tasks (`landfall/CLAUDE.md`, "The Spec-Driven Development workflow").
- **Constitution** (`landfall/.specify/memory/constitution.md`), seven principles: I adopt over build, CNCF-first;
  II security and tenant isolation first, default deny; III stateless and N-up safe; IV event-sourced truth and
  tamper-evident audit; V agents suggest, humans apply (Landfall never executes a change); VI monorepo and NestJS
  discipline; VII spec-driven, test-backed, scenarios as evals.
- **Integration definition of done** (constitution v1.2.0): a docs page with annotated screenshots, agent reach through
  dynamic discovery (no hard-coded per-provider tool), the ability to trigger, and the shared architecture page.
- **UI conventions**: human-readable ids (`{org} {number}`, never a UUID), an integrations wizard with live health
  checks (features 018/019).
- **Constraint for Landbright**: under principle V Landfall must not run access changes. Break-glass access on an
  incident therefore runs in Landflow (Landfall Trigger → policy → grant), with a note back in the room.

## 3. HR sources

### 3.1 HiBob (Bob)

- **Webhooks** are configured in the Bob UI: you pick the events and copy the signing secret. There is no
  subscription API, and Bob first sends a ping that must get a 200.
  https://apidocs.hibob.com/reference/getting-started-webhooks.md
- **Events (v2)**: `employee.created`, `employee.updated`, `employee.deleted`, `employee.joined`, `employee.left`,
  `employee.inactivated`, `employee.activated`, `employee.temporaryLeave`, `employee.access.revoked.immediately`
  (v2 only), `table.entry.created`, `table.entry.updated`. https://apidocs.hibob.com/reference/employee-events-v2
- **Timing**: lifecycle events fire at **midnight in the site's time zone on the effective date**, not when HR enters
  the change. Deleting a table entry fires nothing. (same page)
- **Payload**: thin. `{companyId, type, triggeredBy, triggeredAt, version: "v2", data: {employeeId}}`;
  `employee.updated` adds the changed field ids, but the docs name the key both `fieldUpdates` and `fieldUpdatesIds`,
  so check a real delivery. `employee.deleted` includes the email. (same page)
- **Signature**: header `Bob-Signature`, HMAC-SHA512 of the raw body keyed with the webhook secret, base64.
- **Retries**: exponential backoff for up to 3 days with a 10-second timeout; deactivated after 72 hours without a
  successful delivery.
- **API**: `https://api.hibob.com/v1` (sandbox `https://api.sandbox.hibob.com/v1`). Basic auth with a service user
  (`serviceUserId:token`), which sees only the fields its permission group allows. Hidden fields are silently left
  out and the call still returns 200. https://apidocs.hibob.com/reference/authorization,
  https://apidocs.hibob.com/docs/api-service-users
- **Reads**:
  - `POST /v1/people/search` (`fields`, `filters` on `root.id`/`root.email`; set `showInactive: true` to see leavers;
    no paging).
  - `POST /v1/people/{id or email}` for one person. It's a POST.
    https://apidocs.hibob.com/reference/post_people-search.md, https://apidocs.hibob.com/reference/post_people-identifier.md
- **Field ids**:
  - name: `root.email`, `root.firstName`, `root.surname`, `root.displayName`
  - work: `work.department`, `work.title`, `work.reportsTo` / `work.manager`, `work.site`, `work.startDate`
  - status: `internal.status`, `internal.lifecycleStatus`

  The termination date's field id isn't documented on these pages (third parties use `internal.terminationDate`);
  `GET /company/people/fields` lists them. https://apidocs.hibob.com/docs/people-read-api-contract.md
- **Rate limits per minute**: search 50, read 100, create / update / terminate 10. `X-RateLimit-*` headers; 429 over
  the limit. More than 50 401s or 403s in 10 seconds blocks the IP for 5 minutes. https://apidocs.hibob.com/reference/rate-limiting

### 3.2 Shapes ("Shapes HR")

- **The product**: Shapes (shapes.co), formerly DreamTeam, an "AI-native PeopleOS" at `app.shapes.co`. Its founders
  are early monday.com people, and it is listed in Israel's Startup Nation Central. https://shapes.co/about,
  https://finder.startupnationcentral.org/company_page/shapes
- **API**: no public REST reference. The help center points to a GraphQL schema on Apollo Studio ("DreamTeam-V1"),
  which we could not open. https://intercom.help/Shapes-help-center/en/articles/13616006-where-do-i-find-my-api-tokens
- **Auth**: per-user tokens (My settings → API tokens), acting with that user's permissions. Access tokens last
  15 minutes and refresh tokens 7 days, and each refresh invalidates the previous refresh token.
  https://docs.harmony.io/integrations/hris/shapes
- **Webhooks**: Automations can call a URL when a field changes. Payload, signing and event list are not documented.
  https://intercom.help/Shapes-help-center/en/articles/15921336-integrations-overview
- **Exports**: daily CSV over SFTP, outbound to listed vendors only. SSO with Okta / Entra / Google / JumpCloud /
  OneLogin; SCIM not mentioned. (same page)
- **Unified APIs**: Harmony reads names, email, title, department, status, manager, location, hire and termination
  dates; Merge lists Shapes as beta. https://www.merge.dev/integrations/shapes
- **So**: poll the GraphQL API with a rotating refresh token, optionally nudged by an Automation call, and ask Shapes
  for the schema and webhook format before building. A unified API (Merge, Harmony) is a fallback if Shapes can't help,
  at the cost of a third party in the data path.

## 4. Products we borrow from

### 4.1 Apono (now part of 1Password)

- 1Password acquired Apono (announced around 16 June 2026) and launched a "Credential Broker" in private beta.
  https://idtechwire.com/1password-acquires-apono-and-launches-credential-broker-for-just-in-time-access/ **[secondary]**
- **Access flows** set who can get what, which actions, for how long and who approves; a flow can grant without
  approval. https://docs.apono.io/docs/getting-started/how-apono-works
- **Bundles** are reusable sets of permissions; a flow reuses one and changes only grantees, approvers and duration.
  https://docs.apono.io/docs/access-flows/how-to-use-access-bundles
- **Channels**: Slack (`/apono request`), Teams, CLI, portal, magic links. A request still pending after 7 days fails.
  https://docs.apono.io/docs/access-requests-and-approvals/slack
- **Connectors** run in the customer's environment, sync resources, and grant and revoke. They read secrets from the
  customer's vault only when needed and keep none.
- **Agent Privilege Guard**: agentic access flows (who the agent acts for, what, how long, approval), and an Agentic
  Gateway in front of managed MCP servers. Each tool call is classed Read / Create / Update / Delete / Admin and then
  allowed, sent for approval or denied. Agent sessions are audited apart from human ones.
  https://docs.apono.io/docs/agent-privilege-guard/apono-agent-privilege-guard
- **What we take**: bundles, access flows (our *policies*), Slack-first requests, connectors run where the access is
  (for us, Landflow plugins), tool-call classes for agents.

### 4.2 Okta + Axiom Security

- Okta closed the Axiom acquisition on 4 September 2025. Axiom's cloud PAM features (JIT access, request and approval
  workflows, access reviews) are being folded into Okta Privileged Access, adding JIT for GitHub, Snowflake,
  PostgreSQL and EKS and an AI connector builder.
  https://www.okta.com/newsroom/press-releases/okta-with-axiom-security--delivering-robust-privileged-access-fo/
  Whether those features are GA in 2026 is **[unconfirmed]**.
- **Okta for AI Agents**: agents as identities in Universal Directory with human owners, short-lived scoped tokens,
  shadow-agent discovery, credential vaulting and rotation, and "Universal Logout for AI Agents" as a kill switch.
  https://www.okta.com/newsroom/press-releases/showcase-2026/ The GA date is **[unconfirmed]**: the press release and
  the GA blog post (https://www.okta.com/blog/ai/okta-for-ai-agents-general-availability/) disagree.
- **Cross App Access (XAA)** is Okta's name for ID-JAG: the IdP applies admin policy instead of a consent prompt per
  app. https://support.okta.com/help/s/article/understanding-cross-app-access-with-okta-for-ai-agents
- **Auth0 for AI Agents** (GA 19 November 2025): Token Vault, async authorization over CIBA, FGA for RAG.
  https://auth0.com/blog/auth0-for-ai-agents-generally-available/
- **What we take**: an owner for every agent, the kill switch, cross-app access via ID-JAG, JIT for databases and
  GitHub as early targets.

### 4.3 Others

- **Microsoft Entra Agent ID** (GA, docs dated 1 May 2026): agents are created from **blueprints**, which carry
  credentials and policy for a class of agents, and disabling a blueprint stops every agent made from it. Owners,
  sponsors and managers are separate roles. Access packages cover both on-behalf-of and autonomous agents.
  https://learn.microsoft.com/en-us/entra/agent-id/whats-new-agent-id → **we take blueprints and sponsors.**
- **ConductorOne AI Access Management** (early preview, March 2026): an identity-aware MCP proxy that governs each
  tool call. https://www.c1.ai/news/press-release/introducing-ai-access-management
- **Aembit**: policy on a "blended" identity (agent + user + context) before each tool call, with short-lived
  credentials issued on demand. https://aembit.io/blog/announcing-aembit-iam-for-agentic-ai/ → **we take the
  person ∩ agent scope rule** (plan §4.3).

## 5. Standards

| Standard | Status (2026-11) | Role in Landbright |
|---|---|---|
| OAuth 2.0 Token Exchange, RFC 8693 | RFC (2020). `act` names the acting party and nests for chains; `may_act` says who may act | An agent acting for a person: `sub` = person, `act.sub` = agent. https://www.rfc-editor.org/rfc/rfc8693 |
| ID-JAG (Identity Assertion JWT Authorization Grant) | IETF OAuth WG draft **-06** (31 October 2026). The flow: SSO → token exchange at the IdP for an ID-JAG → present it as an RFC 7523 JWT bearer grant at the resource's authorization server | Cross-app access for agents without a consent prompt per app. https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/ |
| MCP authorization | Revision **2026-07-28**: OAuth 2.1; protected resource metadata (RFC 9728) required; `resource` (RFC 8707) on every request; audience checks; **Client ID Metadata Documents** recommended, dynamic client registration deprecated; RFC 9207 issuer check; step-up on `insufficient_scope`; no token passthrough. The Enterprise-Managed Authorization extension, a profile of ID-JAG, is stable | Landbright as the enterprise IdP for MCP clients and servers. https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization, https://github.com/modelcontextprotocol/ext-auth |
| SPIFFE / SPIRE | CNCF graduated (2022) | Attested workload identity for agents on kagent, later. https://www.infoq.com/news/2022/09/spire-graduates-cncf/ |
| IETF WIMSE "AI Identity Management System" | WG draft **-01** (2 November 2026); applies WIMSE and OAuth to agents rather than inventing protocols | Watch. https://datatracker.ietf.org/doc/draft-ietf-wimse-aims/ |
| Shared Signals Framework, CAEP, RISC | **Final 1.0** (September 2025). CAEP events: `session-revoked`, `token-claims-change`, `credential-change`, `assurance-level-change`, `risk-level-change`. RISC events: `account-disabled`, `account-purged`, `credential-compromise` | Landbright transmits on leaver, agent suspension and revocation. https://openid.net/specs/openid-caep-1_0-final.html |
| AuthZEN Authorization API | **1.0 Final** (12 January 2026); MCP binding still a draft | Landbright's policy evaluation endpoint for apps. https://openid.net/authorization-api-1-0-final-specification-approved/ |
| OpenFGA conditional tuples | Shipped. A tuple carries a CEL condition such as `non_expired_grant(current_time, grant_time, grant_duration)`; `current_time` is supplied at check time | Time-bound grants as relationship tuples. Expired tuples stay in the store, so a cleanup job is still needed (our inference). https://openfga.dev/docs/modeling/conditions |
| SCIM 2.0 | RFC 7643/7644 | Push to Landflow and Landfall |
| Standard Webhooks | Community spec (`webhook-id`, `webhook-timestamp`, `webhook-signature`) | Landbright's outbound events |
| OpenID "Identity Management for Agentic AI" whitepaper | Published 7 October 2025. Argues for interoperable profiles of existing standards, not agent identity silos | The stance behind constitution principle VI. https://openid.net/new-whitepaper-tackles-ai-agent-identity-challenges/ |

## 6. Build or adopt the IdP core

Landfall's constitution (principle I) says identity is to be adopted, not built. Landflow built its own OIDC, SAML and
SCIM because, for Landflow, identity is plumbing. For Landbright, identity *is* the product, but the protocol engine
still isn't the differentiator. The differentiator is the agent identity model, the grant ledger, the policies and the
Landflow integration.

| Option | License, maturity | Token exchange | For | Against |
|---|---|---|---|---|
| **`oidc-provider`** (panva), embedded in NestJS | MIT; v9; OpenID certified incl. FAPI 2.0 and CIBA; RFC 8707, DPoP, RAR, CIMD (experimental) | Custom grant through its registration API (**[unconfirmed]** that this is still the way in v9) | TypeScript like the family; full control of agent token semantics (`act`, ID-JAG, intersections); a small, testable protocol plane; our data model is native | We write and own the token-exchange and ID-JAG grants, the admin model and the sign-in UI |
| **Keycloak 26.8** | Apache-2.0; CNCF incubating | Native standard exchange since 26.2; `act` delegation in preview in 26.8; internal-to-internal only. JWT authorization grant in preview; **SCIM supported**; Shared Signals experimental | The most proven OSS IdP; Landfall and Landflow's infra already run it; much comes for free | Java SPI to extend for agents, sponsors and ledger hooks; Landbright becomes a control plane beside it and our model is split across two stores; heavy for a local stack |
| **Zitadel** | AGPL-3.0 (commercial available); OpenID certified | Native ("first iteration"), `act` supported | Strong multi-org, passwordless | AGPL for an embedded product; Go |
| **Ory Hydra + Kratos** | Apache-2.0; Hydra OpenID certified | RFC 8693 not merged (Fosite PR #821 open) | Headless and composable | No token exchange yet; much assembly |
| **authentik 2026.8** | License **[unconfirmed]**; OpenID certified | Native since 2026.8, impersonation and delegation with `act` | Feature-rich | Python/Go; extending the agent model is hard |

**Recommendation**: `oidc-provider` embedded in a NestJS protocol plane, with Keycloak as the documented fallback. If we
went with Keycloak, the plan's control plane, ledger, plugins, flows and UI would all stay the same. Only `apps/idp`
would be replaced by Keycloak plus an event listener SPI. This is the decision the plan leaves open for you
(plan §11, question 4).

**Next.js instead of NestJS?** A Next.js app with `oidc-provider` in a custom server would match Landflow exactly and
keep one framework across Landflow and Landbright. We advise against it: the protocol plane should stay free of UI
code, deploy and scale on its own, and enforce default deny and audit at the framework level (NestJS guards and
interceptors, Landfall principle VI). The console keeps Landflow's look either way.
