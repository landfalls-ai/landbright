# Open-source JIT access: what the best projects do, and what Landbright should take

**Date**: 2026-11-14 · **For**: Landbright spec 003 (access requests and approvals) · **Method**: shallow clones read from
source, plus each repository's own docs. Nothing was built or installed, and no Landbright or Landflow file was changed.
Clones are in `scratchpad/jit-oss/<name>/`, and every path below is relative to that clone. AGPL, BSL and
Infisical-`ee/` code is described in my own words only, and none of it was copied.

## TL;DR

- **The split spec 003 uses (the IdP decides, the workflow engine talks and provisions) matches the strongest designs.**
  Teleport's plugins are separate processes that watch requests and post messages; when one records a decision, it does
  so as an attributed review that Teleport checks against the person's own permissions. Infisical's newest feature,
  *delegated approval*, treats the external system's callback as a nudge only and **reads the decision back**. Spec 003
  already does the same with "the resume URL is a nudge; the flow re-reads". Thand, the one product whose flows are
  workflows (Serverless Workflow on Temporal), shows the cost of the opposite choice: the quorum and the self-approval
  switch sit inside the editable workflow, and there is no list of who may approve.
- **Spec 003 is missing ten things that most of these products have.**
  1. Multi-party approval with **deny-wins**, one vote per person, and votes re-checked against current eligibility.
  2. **Ordered approval steps**, or at least a data shape that allows them later.
  3. A rule that **access gained from a grant can't be used to approve**.
  4. **Three separate clocks**: decision deadline, grant end, and token lifetime, with tokens capped at the grant's end.
  5. A **scheduled start**.
  6. **Extension rules**.
  7. **Break-glass** that grants now and is reviewed afterwards.
  8. **Auto-approve rules that record their evidence**.
  9. **Per-target provisioning state**, including `revoke_failed` and `verified`.
  10. **Preflight / dry-run** and idempotent "ensure" requests, which is what agents need.
- **The Landflow side is generic and buildable today.** Fourteen flows (F1–F14) cover intake, the approval conversation,
  reminders, escalation messaging, decision notices, provisioning, expiry warnings, revocation, overdue revocation,
  break-glass review, drift reconciliation and ticket enrichment. Each one starts from a Landbright webhook (or a
  Schedule or a Slack webhook), re-reads Landbright over HTTP, and writes results back to Landbright's `/api/v1`. Every
  flow reaches Landbright only through a handful of machine routes, so none of them can make a decision.

## 1. Landscape

| Project | License | Status (checked 2026-11-14) | Approach | Relevance |
|---|---|---|---|---|
| **GoogleCloudPlatform/jit-access** ("JIT Groups" 2.x) | Apache-2.0 | Active (push 2026-11-12, 291★) | Group membership with an expiry in Cloud Identity; IAM is bound to the group. No request database: a pending approval is a **signed JWT inside the approval link**. YAML policy with ACLs and CEL constraints | **High**: policy language, self-approval as a permission, typed justification inputs, no-database design |
| **aws-samples/iam-identity-center-team** (TEAM) | MIT-0 | Active (2026-11-13, 612★) | AppSync + DynamoDB stream → router Lambda → five Step Functions (approval, schedule, grant, revoke, reject); IAM Identity Center account assignments | **High**: explicit state machine, timers, failure handling (and its gaps) |
| **gravitational/teleport** Access Requests | AGPL-3.0 core; `api/` module Apache-2.0 | Very active (21k★) | Approval → the user re-issues certificates carrying the requested roles until `access_expiry`. Role-based thresholds; access monitoring rules; plugins | **High**: multi-party thresholds, reviewer rules, plugin attribution. Design only |
| gravitational/teleport-plugins | Apache-2.0 | Archived 2024 (moved into Teleport's AGPL `integrations/`) | Slack, PagerDuty, Jira, Mattermost, Discord, Opsgenie plugins (history up to commit `8e802fc`, Apr 2023) | **High**: how an outside process takes part without deciding |
| **Infisical/infisical** approval policies | MIT core; `ee/` under the Infisical Enterprise licence | Very active (30k★) | Generic approval engine (MIT): multi-step policies, bypassers (break-glass), auto-approval rules over Jira tickets, **delegated approval** (ServiceNow) with a callback nudge and decision read-back, outbox | **High**: closest to spec 003's ledger and webhook design |
| **thand-io/agent** | **BSL 1.1** (becomes Apache-2.0 on 2029-01-01) | Active (2026-09-19, 36★) | JIT as **Serverless Workflow (CNCF DSL)** documents run on Temporal; `thand:` verbs (validate, approvals, authorize, monitor, revoke, notify) | **High** for flow shape; design only |
| **discord/access** | Apache-2.0 | Active (2026-11-14, 489★) | Okta group memberships as **append-only time-bounded rows**; tag constraints; pluggy hooks (conditional access, notifications, app-group lifecycle); MCP server for agents | **Medium-high**: plugin hook design, expiring-access notices, agent MCP |
| common-fate/common-fate | AGPL-3.0 | **Archived 2024-02** | Access rules (versioned) → Step Functions "granter" (wait start → activate → wait end → deactivate); EventBridge events | **Medium**: good timer idea, and lessons from its terminal `ERROR` state. Design only |
| common-fate/sdk | MIT | Last push 2025-02 | Protobuf API of the later, closed Common Fate platform: separate request and grant, activation vs approval, break-glass activation, extension rules, Cedar policy, `BatchEnsure` with dry-run | **Medium-high**: the most complete field list |
| **atoonk/tailscale-jit** (jitd) | Apache-2.0 | Active (2026-11-13, 5★) | "JIT for people and agents": approval flows set an expiring device posture attribute; MCP server with **no approve tool**; Slack approvals recorded with the Slack identity | **High** for agents and failure handling, despite its size |
| hoophq/hoop | MIT | Active (857★) | Reviews that gate a session (`jit`) or one exact statement (`onetime`, bound by hash); `min_approvals`, `force_approval_groups`, time windows | **Medium**: action-level approval for risky agent tools |
| abbeylabs starter kits | MIT (kits), MPL-2.0 (Terraform provider); product closed | Inactive since 2024 | "Grant kits" as Terraform: review steps `one_of`/`all_of`, Rego policies, provisioning by **pull request** | Low-medium: GitOps provisioning idea |
| common-fate/granted | MIT | Active (1.8k★) | Credential-assume CLI for AWS | Low (not a request workflow) |
| hashicorp/boundary | BSL | Archived | Session brokering, credential injection | Low |
| Netflix/consoleme, lyft/clutch | Apache-2.0 | Archived | AWS policy requests; infrastructure console | Low |
| Opal, Indent, Sym, Apono, ConductorOne, Entitle, Okta IGA | Closed | — | (Opal: Terraform provider only; Indent and Sym SDK repositories are gone) | Reference only (spec 003 already cites the docs) |
| Kubernetes JIT operators | — | No maintained project with traction found (`gh search`) | — | Use group-with-expiry bound by a RoleBinding (JIT Groups style), or Teleport's model |

The deep dives below are the four most relevant (JIT Groups, TEAM, Teleport, Infisical), plus Thand (because its
flows are workflows), jitd (agents), Discord Access and Common Fate.

## 2. Per-project detail

### 2.1 GCP JIT Groups (GoogleCloudPlatform/jit-access), Apache-2.0

Paths under `jit-access/sources/src/main/java/com/google/solutions/jitaccess/`.

**Model.**
- **Policy.** A YAML policy (`schemaVersion: 1`) nests environment → system → JIT group (`catalog/policy/PolicyDocument.java:279-938`).
  - Every level has an ACL and `constraints {join[], approve[]}`.
  - Groups also carry `privileges.iam[]` (project or resource, role, optional IAM condition).
- **Permissions** are bits: VIEW, JOIN, APPROVE_OTHERS, **APPROVE_SELF**, EXPORT, RECONCILE (`PolicyPermission.java:41-71`).
- **ACL principals:** `user:`, `group:`, `serviceAccount:`, `domain:`, `jit-group:env.sys.name` (so one JIT group can make
  someone eligible for another), and `class:iapUsers|internalUsers|externalUsers`.
- **ACL evaluation:** environment, system and group entries are concatenated, and a matching **deny wins**
  (`AccessControlList.java:52-90`).
- **Constraints:**
  - `expiry` takes ISO-8601 min/max. `min==max` means a fixed duration; a group with no expiry constraint can't be joined.
  - `expression` is CEL with typed, bounded `variables[]`, for example a ticket number matching `^[0-9]+$`
    (`resources/oobe/policy.yaml:10-20`).
  - The CEL context exposes `input.*`, `subject.email`, `subject.principals` and `group.*` (`PolicyAnalysis.java:68-78`).
  - A child constraint with the same name overrides its parent's (`Policy.java:69-84`).

**No request database.**
- A *proposal* is a JWT with the claims `usr`, `grp`, `rcp` (recipients), `inp` (inputs), `jti`, `iss`/`aud` (the app's
  service account), `iat` and `exp` (`web/proposal/AbstractProposalHandler.java:111, 210-216`).
- It is signed through IAM Credentials `signJwt` and verified against the service account's JWKS, with issuer,
  audience and algorithm pinned (`ServiceAccountSigner.java`).
- The link carries it in `?f=` because fragments are lost in the sign-in redirect. A cosmetic obfuscation stops phishing
  filters from flagging JWT-looking links (`TokenObfuscator.java`).
- A grant is just a Cloud Identity membership with `expiryDetail.expireTime`, re-read on every request
  (`auth/SubjectResolver.java`).

**States** (implicit):
1. **Join.** If the subject has JOIN + APPROVE_SELF, the membership is provisioned immediately ("joined").
   Otherwise a proposal is emailed ("proposed") (`catalog/JitGroupContext.java:83`).
2. **Approve.** GET on the proposal link is a dry run (APPROVAL_ALLOWED / DISALLOWED); POST executes
   (`web/rest/ProposalResource.java:74-130`).
3. **Expired proposal:** once the token passes `exp` (default lifetime 1 h, `APPROVAL_TIMEOUT`), the link answers 403.
4. **Expired membership:** Cloud Identity removes it by itself.

There is no reject, no cancel and no pending list.

**Rules.**
- **Approvers** are the ACL principals with APPROVE_OTHERS, minus the requester and minus `class:` sets. If that leaves
  nobody, the request is refused up front with "no principals that could approve" (`JitGroupContext.java:355-362`).
- **Authorization is re-checked at approval time against the current policy**; the recipients claim only decides who
  is emailed.
- Exactly **one** approval is needed. The approver can be asked for their own inputs (`approve` constraints).
- Expiry runs from the moment of approval; there is no future start.
- **Extension:** join again while still a member. The expiry is overwritten and the policy re-checked, and the eligibility
  check ignores the current JIT membership, so a member can't keep renewing once their entitlement is gone.

**Provisioning** (`catalog/provisioning/Provisioner.java:256-330, 430-558`):
- Creates the group if needed, then upserts the membership with its expiry.
- Binds IAM to the **group**, not the user.
- Keeps a checksum of the bindings in the group description, so IAM is rewritten only when the bindings change.
- IAM writes use the etag and retry 4 times on 412. They send a `request-reason` header, which shows up in Cloud Audit Logs.
- There is no retry queue: every step is idempotent, so the user retries. A **compliance/reconcile** endpoint finds
  orphaned or drifted groups.

**Other.**
- **Notifications:** SMTP only. Proposals go to the recipients with the requester in CC; approvals go back to the
  requester. The same subject line keeps them in one thread. Templates are HTML with CEL placeholders. No reminders.
- **Audit:** structured logs carrying the user, the device id and the IAP access levels, plus the join and proposal
  inputs (`web/OperationAuditTrail.java`).
- **Service accounts are refused:** "Access is limited to end users" (`web/RequireIapPrincipalFilter.java:87-94`).
- **XSRF:** state changes need the header `X-JITGROUPS: 1`.

**Lessons for Landbright:**
1. Self-approval is a permission a person grants in policy, never an accident. Landbright forbids it outright
   (principle IV), which is stricter and fine.
2. Typed, validated request inputs (a ticket pattern, bounded lengths) beat a free-text reason.
3. Refuse a request at creation when nobody but the requester could approve it.
4. Re-authorize at decision time.
5. Extension = re-request, with eligibility checked while ignoring the grant being extended.
6. A *drift report* is a first-class operation.

### 2.2 AWS TEAM (aws-samples/iam-identity-center-team), MIT-0

Paths under `team/amplify/backend/`.

**Model** (`api/team/schema.graphql`):
- **`requests`:** email, accountId/Name, role/roleId, `startTime`, `duration` (hours), `justification`, `ticketNo`,
  `status`, `comment`, approver/approverId, `approvers[]`, `approver_ids[]` (snapshotted), revoker/revokerId,
  `revokeComment`, `endTime`, `session_duration`.
- **`Eligibility`** (per user or group): accounts, OUs, permission sets, `approvalRequired`, max `duration`.
- **`Approvers`** (per account or OU): approver groups.
- **`Settings`:** global max duration (default 9 h), pending `expiry` (default 3 h), comments required, ticket required,
  approval on/off, and the SES, SNS and Slack settings.
- Policy edits themselves carry `ticketNo` and `modifiedBy`.

**State machine.**
- Statuses: `pending`, `approved`, `rejected`, `cancelled`, `expired`, `scheduled`, `in progress`, `ended`, `revoked`,
  `error`.
- A DynamoDB stream calls `function/teamRouter/src/index.py:321-351`, which starts Step Functions
  (`custom/stepfunctions/stepfunctions-cloudformation-template.json`):
  - **Approval SM:** notify approvers → Wait `$.expire` → if still pending, set `expired`.
  - **Schedule SM:** set `scheduled` → **Wait until `startTime`** → re-read → only if still scheduled, start the Grant SM.
    This gives cancel-before-start for free.
  - **Grant SM:** createAccountAssignment → `in progress` → notify → Wait `duration` → Revoke SM.
  - **Revoke SM:** deleteAccountAssignment → `ended` (or keep `revoked`) → write endTime.
  - **Reject SM:** used for rejected and cancelled; notifies the other side.
- **Idempotency:** each execution is named after the request id, so a retried stream event can't start it twice.

**Rules.**
- **Approver identity is stamped server-side** in the VTL resolver from the caller, never sent by the client.
- **Self-approval is blocked twice:**
  1. the requester's email is removed from the approver list, and the UI filters out the requester's own requests;
  2. the router sets `error` if the resolved approver equals the requester.
- **Display values aren't trusted:** the account name and role are overwritten from Organizations and SSO lookups so
  approvers can't be misled.
- **Approval count:** one approval from any approver.
- **Approval-required logic:** the global switch, unless *any* matching eligibility says no approval. That is loose.
- **Duration:** checked against the per-eligibility and global maximums. There is a subtle bug: it keeps the maximum
  across all entries rather than the entry that matched (`teamRouter:78-97`).
- **Justification:** only "first character alphanumeric". The ticket is a UI-required flag with no pattern.

**Failure handling.**
- SSO calls retry on throttling and conflict (5 times, 3 s, ×2). Notification failures are caught so they never block
  a grant.
- If a grant or revoke fails: `error`, and an email to the admin address with everyone in CC: "check the Step
  Function logs".
- **Nothing rolls back; a failed revoke leaves access in place.**
- **Early revoke:** sets `revoked` and starts the Revoke SM. The still-running Grant SM timer later calls revoke again.
  The guard meant to skip that has a JSONPath with a trailing space (`…template.json:647`), so it looks broken.
- **Open sessions** keep working until the permission set's session length runs out (`docs/docs/overview/security.md:21-22`).

**Other.**
- **Notifications** (`function/teamNotifications/src/index.py`): SES email, an SNS topic carrying the whole event (the
  integration hook), and Slack DMs found by email and localized to the user's timezone, plus an audit channel.
  No reminders and no escalation.
- **Audit:**
  - The `requests` table is the approval log, and Auditors can read everything.
  - Session activity comes from CloudTrail Lake queries over the grant window (`teamgetLogs`), padded by 1 h for open
    sessions. The query is string-built.
- **Machine access:** a Cognito `client_credentials` client reaches admin models only.
- **Non-human:** none. Assignments are hard-coded to `USER`.
- **No extension:** you file a new request.

**Lessons:**
1. Make the timer a durable part of the workflow, and re-read state after every wait.
2. Name workflow runs after the request or grant id so duplicate events start nothing new.
3. Stamp the decider from the session, not from the payload.
4. Overwrite display fields from the source of truth.
5. Keep an explicit `error` state, but never let a revoke failure be terminal. Landbright's sweeper plus re-sent
   `grant.expired` is the fix.

### 2.3 Teleport Access Requests (AGPL; `api/` Apache-2.0) and its plugins (Apache-2.0 history)

Paths: Teleport sparse clone at `teleport/` (commit 1283425); plugins history at `tp-hist/` (commit `8e802fc`, the
last Apache-2.0 tree before the move to AGPL `integrations/`). Design ideas only.

**Request** (`api/proto/teleport/legacy/types/types.proto` ~3491).

| Field group | Contents |
|---|---|
| Who and what | user, requested roles, requested resources (resource IDs) |
| State and record lifetime | state, created, record `expiry` (pending lifetime) |
| Reasons | requester reason, resolve reason, resolve annotations |
| **System annotations** | computed from the requester's role, with traits filled in; the **only channel by which policy tells plugins where to route** |
| **Snapshotted rules** | thresholds plus a role → threshold-index-sets map, fixed at creation |
| Reviews | the reviews themselves, suggested reviewers |
| Time fields | `max_duration` (access end), `session_ttl` (certificate lifetime), `assume_start_time` |
| Other | `dry_run`, request kind |

A **review** has an author, a proposed state, a reason, the threshold indexes it matched (computed by the server), an
assume-start time, and the newer `SubmittedBy` field for reviews a plugin files on a person's behalf.

**States.**
- PENDING → APPROVED | DENIED | PROMOTED (made into an access-list membership).
- Resolved requests are final.
- The pending TTL is the requested value, else 7 days, never past the access end. On approval the record's lifetime is
  reset to the access end.
- An expiry job (under a lease, every 5 min, 120 at a time) emits `access_request.expire` and deletes the request.
  Plugins see the delete as "expired".

**Policy.**
- **Who may request** (`allow.request`): roles (wildcards), `claims_to_roles`, `search_as_roles` (resource requests),
  thresholds, suggested reviewers, annotations, `max_duration` (capped at 14 days), and
  **`reason: {mode: required|optional, prompt}`**.
- **Deny rules** use the same fields. Role option `request_access: optional|reason|always`.
- **Who may review** (`allow.review_requests`): roles, `claims_to_roles`, and a **`where` condition** over the
  reviewer's traits and the request (roles, reason, annotations). **Requester traits are deliberately hidden** from it.
  Also `preview_as_roles` and `submit_for_users`.

**Who may review a given request** (`lib/services/access_request.go` ~909):
1. Never your own request.
2. Deny rules first.
3. Every requested role must be covered by an allow rule.
4. **The reviewer's permissions are computed from their stored roles, not from roles in their current certificate**,
   so access gained by one request can't approve another.

**Multi-party thresholds** (`calculateReviewBasedResolution` ~696; RFD 0026):
- A threshold is `{name, filter, approve: N, deny: M}`.
- Each review records which thresholds' filters it matched. A review that matches none is recorded but counts for nothing.
- **Combining:** for each role, every index set must have at least one satisfied threshold (AND across sets, OR within
  a set). The request is approved when all roles are.
- **Deny wins:** reviews are replayed in order, and the first threshold to reach its deny count denies the whole request.
- One review per author. The default is approve 1 / deny 1.

**Activation.**
- Nothing is issued at approval. The user re-issues certificates naming the active request ids, and the server checks
  each time (`lib/auth/auth.go:5389-5430`):
  - the request is approved;
  - it still passes validation against current policy;
  - the access end hasn't passed;
  - any assume-start time has passed.
- **Certificate lifetime is truncated to the access end** (`truncateTTL`).
- **Assume later:** up to 7 days ahead.
- **Early end:** `tsh request drop` re-issues without the request.
- **Hard revoke:** a **lock** targeting the request id. Deleting a request only stops future re-issues.

**Automatic review (access monitoring rules, RFD 0201).**
- A rule has a condition over request roles, user, reason, annotations, resource labels and requester traits; optional
  weekday **schedules** with a time zone; notification routing to a named plugin's recipients; and
  `automatic_review {decision APPROVED|DENIED, reason}`.
- The built-in reviewer submits an **ordinary review as a system user** (`@teleport-access-approval-bot`).
- **A matching DENIED rule wins.**
- The automatic review counts as **one** review toward thresholds, so `approve: 2` still needs a person.

**Plugins** (`tp-hist/lib/watcherjob/watcherjob.go`, `tp-hist/access/common/app.go`):
- **Process model:** separate processes with their own identity. They watch request events (in order per request,
  parallel across requests, reconnect with backoff), announce pending requests, and edit messages on resolution.
- **State:** stored **on the request itself as plugin data with compare-and-swap** (message ids, reviews already
  posted), so plugins keep no database (`tp-hist/access/common/plugindata.go`, `tp-hist/lib/plugindata/cas.go`).
- **Routing:** recipients come from `role_to_recipients`, plus suggested reviewers that are emails.
- **Slack, Mattermost, Discord** only notify.
- **PagerDuty:** looks the requester up by email; if they are on call for one of the services named in the
  `pagerduty_services` annotation, it submits an **approve review as itself** (it needs `review_requests` for those roles).
- **Jira:** turns an issue transition into an *admin set-state* with `delegator=jira:<email>`. This **bypasses
  thresholds** and needs update rights: trust in the ticket system.
- **On-behalf-of reviews** (`lib/auth/auth_with_roles.go:3590-3690`): the caller becomes `SubmittedBy`, the author is
  the person, and Teleport checks `submit_for_users` and then the **author's own** review permissions.

**Audit:** `access_request.create`, `.update` (admin set-state, with delegator), `.review` (reviewer, submitted-by,
proposed and resulting state), `.delete`, `.expire` (`lib/events/api.go:208-216`).

**CLI:** `tsh request create --roles --reason --reviewers --max-duration --assume-start-time --request-ttl`,
`tsh request review --approve|--deny`, `tsh request drop`, `tctl requests approve|deny --delegator`. `dry_run` returns
the reason mode, prompt and reviewers before submitting.

**Non-human.**
- Bots can't attach requests to their own certificates, but they can *review* (that is how plugins run).
- RFD 0238 (draft, `rfd/0238-delegating-access-to-ai-workloads.md`): "delegation sessions" where a person lends a
  workload a time-limited, deny-by-default set of resources, attributed to both, revocable at once.

**Lessons:**
1. Snapshot the rules onto the request.
2. Use deny-wins thresholds.
3. Compute reviewer eligibility from *standing* access only.
4. Make every automated decision an ordinary attributed review that still counts toward the quorum.
5. Let plugins keep their state on the request with CAS.
6. Keep pending TTL, access end and token lifetime separate, and cap tokens at the access end.
7. A dry run tells the requester what they'll need.
8. Hard revocation is a separate mechanism from ending the request.

### 2.4 Infisical approval policies (Infisical/infisical) — MIT core; `ee/` under the Infisical Enterprise licence

The new generic engine lives in MIT code: `backend/src/services/approval-policy/`, schemas in
`backend/src/db/schemas/approval-*.ts`, delegated approvals in `backend/src/services/delegated-approval*/`. The older
`access-approval-*` is under `ee/` (design only).

- **Policy** (`approval-policies.ts`): type (pam-access, secret-access, secret-change, cert-request, cert-code-signing),
  scope, `maxRequestTtl`, `conditions`, `constraints` (e.g. `accessDuration.max`), `enforcementLevel` hard|soft,
  `bypassForMachineIdentities`, `isActive`. **Steps** (`approval-policy-steps.ts`): ordered `stepNumber`, `name`,
  `requiredApprovals`, `notifyApprovers`; each step's approvers are users or groups
  (`approval-policy-step-approvers.ts`). **Bypassers** (users/groups) for break-glass
  (`approval-policy-bypassers.ts`).
- **Request** (`approval-requests.ts`): policyId, requesterId **or** `machineIdentityId`, requester name/email
  snapshot, type, status, `justification`, `currentStep`, `requestData`, `expiresAt` (the pending deadline),
  `autoApprovedAt`, `autoApprovalEvidence`. On creation the policy's steps are **copied** onto the request
  (`approval-request-steps.ts`: status pending|in-progress|completed, startedAt, completedAt; and
  `approval-request-step-eligible-approvers.ts`), so editing a policy doesn't move requests in flight. Votes:
  `approval-request-approvals.ts` (stepId, approverUserId, decision approved|rejected, comment).
- **Grant** (`approval-request-grants.ts`): grantee user or machine identity, status active|expired|revoked, type,
  attributes, expiresAt, revokedAt/revokedByUserId/revocationReason, **`isBreakGlass` + `bypassReason`**.
- **States** (`approval-policy-enums.ts`): request pending → approved | rejected | expired | cancelled; step pending →
  in-progress → completed; grant active → expired | revoked. Notification events: requested, approved, rejected,
  bypassed, auto-approved. Audit actions: request-created, request-reviewed, request-bypassed,
  request-auto-approved, grant-revoked.
- **Approve** (`approval-policy-service.ts:1531-1730`): request must be pending and not past `expiresAt` (else it is
  flipped to expired); actor must be a named user or in a named group **of the current step**; one vote per approver
  ("already approved"); under a row lock (`findByIdForUpdate`) the vote is added, and when the step's count is met the
  step completes and the next starts (with notifications to its approvers) or the request becomes approved and a
  domain hook creates the grant **in the same transaction** (`postApprovalTxRoutine`). Any rejection rejects. Note:
  self-approval is only forbidden for code signing (`:1630`); the older access policy has `allowedSelfApprovals`
  default **true** — a weaker default than Landbright's.
- **Break-glass** (`:233-260`, `:448-560`): only the requester, only on a pending request, only if the policy is
  `soft` and the actor is a bypasser (or there are no bypassers); a reason of **≥10 characters**; constraints
  re-validated against the policy as it is now; all steps closed, request approved, grant marked `isBreakGlass`, a
  `bypassed` event sent to the approvers. Access first, review after.
- **Auto-approval** (`auto-approval/auto-approval-types.ts`, `providers/jira-auto-approval-provider.ts`): a policy has
  *inputs* (fields the requester fills, e.g. a Jira ticket, from a connection) and ordered *rules*, each a list of
  *conditions* (subject, constraint, values). Jira constraints: is assigned to the requester, is approved in Jira, has
  status, is in project, is of type, has label, and **not used before** (a ticket can unlock only one request,
  checked against earlier approved requests, by a stable id that survives renames). Each test returns pass + a
  human-readable reason shown to requester and approvers; the facts are stored as `autoApprovalEvidence`.
- **Delegated approval** (ServiceNow; `delegated-approval-request` schema + services): the decision is made in an
  external system. Status pending_dispatch → waiting_approval → approved | rejected, or failed_dispatch / failed.
  Infisical dispatches via its outbox with a **per-request callback token** (32 bytes, prefixed, stored encrypted,
  compared in constant time). The external system calls `POST /api/v1/delegated-approvals/callback` with the token
  and its own request id; the callback **is only a nudge**: it claims a "decision read" (a 70-minute lease so
  duplicates collapse), counts attempts (max 5, then the request fails and must be re-created), and an outbox consumer
  **reads the decision back** from ServiceNow and applies it (`delegated-approval-callback-service.ts`,
  `delegated-approval-decision-service.ts:227-229`, constants files). The same shape as Landbright's "resume is a
  nudge; the flow re-reads".
- **Preflight.** `checkPolicyMatch` returns requiresApproval, hasActiveGrant, the duration constraint and the
  auto-approval inputs the form must ask for (`approval-policy-service.ts:~2250`).
- **Expiry** is lazy (`expiresAt < now` at check time) plus a bulk status update (`approval-request-dal.ts:291-293`);
  access is enforced by Infisical's own permission check, so there is no downstream to fail.

### 2.5 Thand agent (thand-io/agent) — BSL 1.1, design ideas only

Paths relative to `jit-oss/thand/`.

- **Model.** `ElevateRequest` = role (inline object, not just a name), providers[], authenticator, workflow, reason,
  duration (ISO 8601), identities[] (who gets elevated; default the requester; may be other identities), tenants[]
  (`internal/models/elevate.go:58-68`). Valid only with role, providers and reason (`:70`). Workflow picked from the
  request, else the role's first workflow (`:91`). A **Role** has authenticators, workflows (≤5), providers, inherits
  (provider-native policy ARNs or other roles), permissions allow/deny, resources, and `scopes` {users, groups,
  domains} = who may be elevated (`internal/models/role.go:220-236`, `examples/roles/aws.example.yml`). No max
  duration on the role; the static validator checks only that duration parses (`docs/configuration/workflows/tasks.md`
  §validate).
- **Flows are Serverless Workflow (CNCF DSL 1.0) documents run on Temporal.** Example flows:
  `examples/workflows/thand.approvals.example.yml`, `slack.approval.example.yml`. Custom task verbs under `thand:`:
  `validate` (static or LLM), `approvals`, `authorize`, `monitor`, `revoke`, `notify`, `form`, `agent`
  (`internal/workflows/tasks/providers/thand/*.go`). Ordinary DSL tasks (`listen`, `switch`, `call: http`, `emit`,
  `try`, `fork`, `wait`) run alongside (`sdk/workflows/runner/*.go`). State/audit = Temporal history plus search
  attributes (status, approved, task, user, role, workflow, providers, identities)
  (`internal/workflows/common/search_attributes.go`).
- **Approvals task** (`approvals.go`): options `approvals` (count, default 1), `selfApprove` (default false),
  `notifiers` {slack|email: to, message}; `on: {approved: <state>, denied: <state>}`. It sends notifications once,
  then listens for CloudEvents of type `com.thand.approval` (`notify.go:21`). Each vote is stored in workflow context
  keyed by the approver's identity (one vote per person; `approvals.go:315`). Any `approved:false` → denied;
  count of true ≥ N → approved; else loop and listen again (`approvals.go:333-345`). Self-approval check covers the
  requester **and every identity being elevated** (`:227-298`); a refused vote sends the voter a rejection notice.
  **Gap:** nothing restricts *who* may approve beyond "not self": anyone with a session and the link counts; the
  notifier's `to` is only who is told. The approval decision lives inside the workflow, i.e. in the engine.
- **Approval links.** The callback URL carries the task state **encrypted** (`internal/config/model.go:404-421`,
  `GetSignalCallbackUrl`); the handler requires a signed-in session, decrypts, and stamps the **approver identity
  from the session** onto the event before signalling Temporal (`internal/daemon/executions.go:545-615`). So the link
  identifies the request, the session identifies the person. A shortcut `GET /execution/:id/approvals?approved=true`
  also exists (`executions.go:675-704`): a state change on GET.
- **Authorize / expiry.** `authorize` fans out one task per provider × identity × tenant, in parallel, as child
  workflows on the agent's task queue (`authorize.go:160-200`, `:378`); succeeds if **at least one** authorization
  succeeds, fails only if all fail (`:258-266`) — partial grants are possible. Expiry is a scheduled termination
  request on the workflow (`scheduleRevocation`, `authorize.go:434-545`) with `ScheduledAt = authorizedAt + duration`
  and `EntryPoint = <revoke state>`; with no Temporal it falls back to an in-process scheduler. Workflow
  cancellation/termination always runs cleanup that jumps to the revocation entrypoint
  (`internal/workflows/manager/workflows.go:80-220`) — cancelling a run revokes. Activity retry policy 1 s → 1 min,
  5 attempts (`sdk/workflows/runner/common.go:15-20`).
- **Monitor** (`monitor.go`, docs §monitor): listens for `com.thand.alert` events and revokes on a critical one —
  "access is reviewed during usage". LLM monitoring is declared but not implemented (docs say parameters unused).
- **API.** `/elevate` GET/POST (static request via query string), `/elevate/llm` (natural-language request → structured
  request), `/elevate/resume`, `/executions`, `/execution/:id` + `/cancel` `/terminate` `/signal` `/approvals` `/form`
  (`internal/daemon/server.go:480-520`).
- **Non-human.** `identities[]` lets a request elevate identities other than the requester (users or groups;
  `internal/models/identity.go:13-28`); the "agent" in Thand is a **deployment agent** (a worker near the target), not
  an AI identity. LLM features are request-shaping and validation, not deciding.

**Lessons.** (1) Thand proves the *shape* the user wants: approval, provisioning, revocation as an editable workflow
document whose steps are generic (listen, switch, http) plus a few domain verbs. (2) It also shows the risk the
Landbright plan avoids: the decision (quorum, who may vote) lives in the workflow, so a flow edit can change who may
approve and there is no approver list. Landbright keeps the quorum in policy and lets the flow only *carry* votes.
(3) "Cancel the run ⇒ run revoke" and "schedule revocation at grant time, inside the engine" are good, but must not
be the only path: Landbright's sweeper remains the backstop.

### 2.6 tailscale-jit / jitd (atoonk/tailscale-jit) — Apache-2.0, active, "people and agents"

Paths relative to `jit-oss/tailscale-jit/jitd/`.

- **Flow model** (`internal/jit/model.go`, `Workflow`): attribute (the one thing an approval sets), resources ("gives
  access to", discovery only), `requesters[]`, `approvers[]` (principals: a login, a `group:`, a `tag:`,
  `autogroup:member`), `allow_self_approval`, `max_duration` (default 1 h), `default_duration`, `approval_timeout`
  (default 24 h), `approvals_required` (1..10), `disabled` (stops new requests and approvals; live access runs out),
  Slack {channel, dm_approvers, **browser_only**: no buttons in Slack, decisions only in the browser}. Hard cap 365 days
  so a typo can't become permanent access.
- **Request** (`AccessRequest`): flow snapshot (attribute, resources), requester identity (login, device, tags, `via`),
  target device, duration, reason (required, ≤2000 chars), status pending|approved|declined|expired|revoked|cancelled,
  timeline of events (submitted, approval, approved, approve_failed, declined, cancelled, revoked, revoke_failed,
  expired, each with actor, note, via, slack_user), approvals[], approvals_required, **enforcement** (what was verified
  on the device), approved_at, expires_at, last_error, the Slack messages posted (to update them later).
- **Rules** (`internal/jit/service.go:737-835`): pending only; browser-only flows refuse Slack votes; approver must
  match the flow; self-approval only if allowed; disabled flows refuse; stale requests refused; **one vote per
  person**; votes are **re-counted against the flow as it is now** (`ApprovalsCounted`: a removed approver's vote no
  longer counts); on quorum the duration is **clamped to the flow's current max** with a note. If the downstream call
  fails, the request goes back to pending, the vote is dropped so the approver can retry, `approve_failed` is on the
  timeline, and it tries to undo a half-applied change. After success it **reads the device back** to confirm, and
  after expiry it keeps reading back for a recheck window until the attribute is seen gone (`:839-870`, `:1039-1100`).
- **Agents.** An MCP server at `/mcp` with five tools: list_requestable, request_access, wait_for_access,
  get_access_request, cancel_access_request — **no approve tool** (README). The README is candid: the agent runs as the
  person, so on a flow that allows self-approval only its instructions stop it from approving with curl. Slack votes
  record the Slack team/user id beside the matched login.


### 2.7 Discord Access (discord/access), Apache-2.0

Paths under `discord-access/`.

**Model.**
- **A grant is a membership row** `OktaUserGroupMember`. It holds the user, the group, `role_group_map_id` (set when
  the access comes through a role), `is_owner`, `created_at`, `ended_at`, the created and ended actors,
  `created_reason`, and `should_expire` (an owner chose "do not renew") (`api/models/core_models.py:51-165`).
- **Rows are never updated.** An extension ends the old row and inserts a new one, so the table *is* the history
  (`api/operations/modify_group_users.py:250-254`).
- **`AccessRequest`:** status, requester, group, ownership flag, `request_reason`, `request_ending_at`, resolver,
  `resolution_reason`, `approval_ending_at` (the approver may change the end), `approved_membership_id` (the link to
  the grant row), `resolved_at` (`core_models.py:757-839`). Role and group requests are similar. A group request
  carries paired `requested_*`/`resolved_*` fields so the approver can edit before approving.
- **Policy = tag constraints:** `member_time_limit`, `owner_time_limit`, `require_member_reason`,
  `require_owner_reason`, `disallow_self_add_membership`, `disallow_self_add_ownership`. When several tags apply they
  are merged per key: the smallest limit wins and the flags are OR'd (`core_models.py:1094-1126`, `api/models/tag.py:297-326`).

**States: PENDING → APPROVED | REJECTED.** There is no cancelled state; a requester "rejects" their own request.
- **Approve:** takes the row with `SELECT … FOR UPDATE`, conflicts if it isn't pending, and refuses the requester
  (`api/operations/approve_access_request.py:43-50`).
- **A direct add of the same access auto-approves any matching pending request** (`modify_group_users.py:708-813`).
- **A new request supersedes an older pending duplicate**, which is rejected with "Superseded…"
  (`api/routers/access_requests.py:244-263`).
- **Expiry:** a cron rejects requests older than 7 days, or whose requested end has already passed (`api/syncer.py:521-684`).

**Approvers** (`api/operations/create_access_request.py:82-95`), in fallback order:
1. group owners;
2. app owners, when there are no owners or the only owner is the requester;
3. Access admins.

Exactly one approval is needed.

**Activation.**
- Commit first, then call Okta as background tasks (`api/operations/_fan_out.py`). Failures are logged, never surfaced.
- **There is no expiry job:** a row past `ended_at` is simply inactive, and the `access sync` cron in authoritative mode
  removes it from Okta. So expiry is only as precise as the cron.
- Okta membership is removed only if no other active row (direct or via a role) still grants it.

**Notifications:**
- Hooks fire on created and completed.
- The expiring-access digests (`access notify` cron) tell users about access ending tomorrow and in a week. On Fridays
  the window stretches over the weekend. Owners get this week and next week; `should_expire` rows are skipped.
- No reminders or escalation for undecided requests.

**Plugins (pluggy, async)** (`api/plugins/*.py`):
- **Conditional access:** `access_request_created(request, group, tags, requester)` and the role and group variants.
  They return approve or reject with a reason and an optional end. The first answer wins; a crash means "no decision".
- **Notifications:** request created/completed, `access_expiring_user/owner/role_owner`.
- **App-group lifecycle:** `group_created/updated/deleted`, `group_members_added/removed`, and a full-reconcile
  `sync_group`. These plugins receive a capability context rather than a database session, and the host owns commits.

**Other.**
- **Audit:** structured events (ACCESS_CREATE/APPROVE/REJECT, GROUP_MODIFY_USER and others), each with
  `source = web|mcp|cli`.
- **Agents:** an MCP server with scopes `read_all` and `create_requests`. **Approving is never exposed over MCP**
  (`api/mcp/tools.py:127-157`).

**Lessons:**
1. Supersede duplicate requests.
2. Auto-resolve pending requests when the same access is granted another way.
3. Use an owner fallback chain for approvers.
4. Expiring-access notices are a notification *schedule*; "do not renew" is a stored choice.
5. Never remove downstream access that another live grant still needs. Landbright must reference-count when two grants
   or a standing membership give the same group.

### 2.8 Common Fate (common-fate/common-fate, AGPL, archived) and its SDK (MIT)

Paths under `common-fate/` (design only) and `cf-sdk/proto/`.

**The archived open-source version.**

*Model:*
- **Request:** requester, rule, **pinned `RuleVersion`**, selected arguments, status, optional reason, requested timing
  (duration and an optional start), approver-override timing, an embedded grant, and approval method AUTOMATIC or REVIEWED.
- **Rule:** versioned; requester groups, approver groups and users (none means auto), a target, and a max duration.
- **Reviewer rows** (one per eligible approver, holding a Slack message id) and an append-only `RequestEvent` history
  (`pkg/access/*.go`, `pkg/rule/accessrule.go`).

*States:*
- Request: PENDING → APPROVED | DECLINED | CANCELLED. One review decides.
- Grant: PENDING → ACTIVE → EXPIRED | REVOKED | **ERROR (terminal)**.
- **Overlap check:** a request is refused if the user already has an active or pending grant with the same target
  arguments (`overlap.go`).

*Activation:*
- One Step Functions execution per grant, named after the grant id: end-in-future check → wait start → activate →
  wait end → deactivate, passing along the provider's opaque state
  (`deploy/infra/lib/constructs/targetgroup-granter.ts:56-139`).
- **Provider errors aren't retried.** The grant goes to ERROR, and a failed deactivation leaves access in place, while
  the Slack message promises "we'll keep trying".

*Other:*
- **Auto-approval:** a synchronous external Lambda answers AUTO_APPROVED or REQUIRES_APPROVAL
  (`pkg/autoapproval/autoapproval.go`).
- **Events:** EventBridge `request.created/approved/declined/cancelled` and `grant.created/activated/expired/revoked/failed`.
- **Session tracking:** access tokens tie downstream sessions to a request (`/webhook/v1/access-token/verify`,
  `/webhook/v1/events-recorder`).

**The SDK protos (the later platform), the most complete field list.**

*Request and grant are separate objects:*
- An **AccessRequest** is a batch of grants, with a justification `{reason, attachments: Jira}`, `reviewers[{user,
  decision}]` and a `workflow_id`.
- Request status: PENDING, ACTIVE, CLOSED. A `ClosingReason` records why: EXPIRED, MANUAL,
  REQUESTED_TO_APPROVED_EXPIRED, APPROVED_TO_ACTIVATION_EXPIRED, REQUESTED_TO_ACTIVATION_EXPIRED.
- A **grant** keeps its status (PENDING/ACTIVE/CLOSED) **separate from `ProvisioningStatus`**
  (NOT_ATTEMPTED/ATTEMPTING/SUCCESSFUL).
- Grant timestamps: `expires_at`, `activated_at`, `deprovisioned_at`, `closed_at`, `try_extend_after`.
- Grant `Extension {remaining, extension_duration_seconds, extension_used, extendable_after}` and
  `approval_steps[{name, completed_by}]`.
- The principal may be a **service account** (`access/v1alpha1/*.proto`).

*Actions are separate:*
- `ApproveAccessRequest`, `ActivateAccessRequest` (with `breakglass` and a CEL-enforced mandatory `breakglass_reason`),
  and `CloseAccessRequest {force_close}`, which closes even if deprovisioning fails.
- `GetAccessRequestActions` tells a user which buttons they may press: approve, activate, break-glass activate,
  extend, force close.

*Workflow configuration:*
- `access_duration`, `default_duration`, `try_extend_after`, `priority`.
- **Three expiry windows:** request → approved, approved → activated, request → active.
- `validation {has_reason, reason_regex, has_jira_ticket}`.
- `extension_conditions {maximum_number_of_extensions, extension_duration_seconds}`.
- `approval_steps[{name, when}]`.
- Policy is **Cedar**, including a `BreakglassActivate` action.

*Preflight and tooling:*
- **`BatchEnsure`** is a declarative, idempotent "ensure I have X" with `dry_run`. It returns the existing request or a
  new one, the validation still needed, durations, and per-grant changes (REQUESTED, ACTIVATED, EXTENDED,
  PROVISIONING_FAILED).
- Admin "why" tools: `DebugEntitlementAccess` and `PreviewEntitlementAccess`.

*Provisioners* are webhooks with declared capabilities. The message carries the grant, the principal and the
`domain_principal` (the subject mapped into the target system).

**Lessons:**
1. Pin the policy version.
2. Separate grant state from provisioning state.
3. Separate approval from activation (approve now, activate within a window), which is the hook for break-glass.
4. Make extension a counted, policy-bounded action with an `extendable_after`.
5. Use an overlap check or an idempotent ensure.
6. Record closing reasons.
7. Never let a provisioning error be terminal.

### 2.9 Others, briefly

- **hoop.dev** (hoophq/hoop, MIT): reviews gate a session or a single statement. `gateway/models/reviews.go`: type
  `jit` (a time window) or `onetime` (one command, bound by SHA-256 of the exact statement), status
  PENDING→APPROVED|REJECTED→PROCESSING→EXECUTED, REVOKED, EXPIRED; `review_groups` (per-group votes), `min_approvals`,
  **`force_approval_groups`** (a group whose one approval settles it: break-glass by named group),
  `access_duration_sec`, `time_window` (allowed hours), `approval_ttl_sec`, owner Slack id. Lesson for agents: approve
  *an action*, not just a role, for the riskiest agent tools.
- **Abbey Labs** (starter kits, MIT; terraform provider MPL-2.0; product closed): a *grant kit* has `workflow.steps[]`
  of `reviewers {one_of | all_of}`, OPA/Rego `policies` (e.g. `expire_after("6h")`), and an `output` that appends
  Terraform to a Git repo: provisioning is a pull request, revocation removes the block (`jit-oss/abbey/main.tf`,
  `policies/common/common.rego`). Last activity 2024.
- **HashiCorp Boundary** (BSL, repository archived 2026): session brokering and credential injection, not access
  requests; out of scope. **Netflix ConsoleMe** and **Lyft Clutch** (Apache-2.0) are archived. **Opal, Indent, Sym,
  Apono, ConductorOne, Entitle**: closed (Opal has only a Terraform provider; Indent/Sym SDK repos are gone).
  **Granted** (common-fate/granted, MIT, active): a credential-assume CLI; Common Fate's access workflows were in the
  archived AGPL repo and the later closed platform.
- **Kubernetes:** no maintained OSS JIT operator with traction turned up; Teleport's Kubernetes access requests and
  Thand/GCP-style "group with expiry" bound to a RoleBinding are the practical options.

## 3. What Landbright should adopt

Spec 003's backbone is confirmed by the evidence and should stay:

- the decision is made in Landbright;
- a flow resume is a nudge followed by a re-read;
- deliveries are Standard Webhooks with snapshots;
- the sweeper is the backstop;
- agents may request but never decide.

The items below are **changes or additions to spec 003**. Each is tagged with where it lands (phase 1 = ledger and
policy, 2 = events out, 3/4 = Landflow) and the evidence behind it.

### 3.1 Confirmations (keep, and say why in the plan)

| Spec 003 decision | Confirmed by |
|---|---|
| Decision stays in the IdP; the workflow engine runs the conversation | Teleport plugins only notify or file attributed reviews, checked against the author's own rights; Infisical's delegated approval re-reads the decision; Thand shows the failure mode (quorum and self-approval switch inside the editable flow, no approver list) |
| Resume or callback = nudge, then re-read | Infisical `delegated-approval-callback-service.ts` (token, claimed read with a 70-min lease, ≤5 attempts, outbox read-back) |
| The decider is identified by their Landbright session, not by the link | Thand stamps the approver from the session onto the signal (`daemon/executions.go:545-615`); TEAM stamps `approverId` in the resolver |
| The sweeper is the backstop; never trust the workflow alone to revoke | Common Fate's terminal ERROR and TEAM's "failed revoke leaves access" are the counter-examples; jitd reads back until the access is seen gone |
| Agents request, never decide | Discord's MCP has no approve tool; jitd's MCP has no approve tool; Teleport bots can't attach requests to themselves |
| Policy versioned and recorded on the request | Common Fate pins `RuleVersion`; Teleport snapshots thresholds; Infisical copies the steps onto the request |

### 3.2 Data model changes (phase 1)

**`policy`**: add these fields.

| Field | Meaning | Evidence |
|---|---|---|
| `steps[]` = `{name, approvers: [groups, users, "manager", "bundleOwner", "sponsor"], approvalsRequired}` | Replaces the single `approvers` + `approvalsRequired`. Ship v1 with one step, but store an array so sequential steps (manager, then owner) need no migration | Infisical steps, Common Fate SDK `approval_steps`, Abbey `steps[]` |
| `denyWins: true` (fixed, not configurable) | One denial by an eligible approver ends the request | Teleport `deny: 1`, Thand, Infisical |
| `approverFallback: ["bundleOwner", "tenantAdmins"]` | Used when a step resolves to nobody but the requester. If still empty, **refuse the request at creation** ("no one can approve this") | Discord owner → app owner → admin; JIT Groups refuses up front |
| `reason: {mode: required\|optional, prompt, minLength}` | Requester-facing prompt shown on the form and returned by preflight | Teleport `reason.mode/prompt`; Discord per-tag requirements |
| `ticket: {mode: required\|optional, system: jira\|landfall-incident\|free, pattern, uniquePerRequest}` | A typed reference, not text in the reason. `uniquePerRequest`: a ticket unlocks one request | JIT Groups CEL variables; Common Fate SDK `has_jira_ticket`, `reason_regex`; Infisical "not used before" |
| `maxDuration`, `defaultDuration` (exist) + `durationClamp: true` | On approval, clamp to the policy's *current* max and note it on the timeline | jitd clamps at approval; Teleport caps at the smallest max |
| `decisionDeadline` (exists) | Keep. Defaults seen: 1 h (JIT Groups), 3 h (TEAM), 24 h (jitd), 7 d (Teleport, Discord). Suggest **4 h**, and for agents **15 min** | — |
| `scheduling: {allowFutureStart, maxStartDelay: 7d}` | A request may ask for `startsAt`; the grant activates then | TEAM `startTime`; Teleport `assume_start_time` (≤7 d); Common Fate start time |
| `extension: {allowed, maxExtensions, extensionDuration, extendableBefore: 30m, requiresApproval: auto\|same-as-request, maxTotalDuration}` | Makes "Extend is a new request on the same grant" concrete and bounded | Common Fate SDK `Extension`, `extension_conditions`, `try_extend_after`; JIT Groups re-join |
| `autoApprove: [{name, when: <conditions>}]` | Conditions over **facts Landbright owns or fetches itself**. Each pass is recorded with its evidence | Infisical auto-approval rules and Jira conditions; Teleport automatic review; Discord conditional access |
| `breakGlass: {allowed, eligible: [groups], maxDuration, reasonMinLength: 10, reviewWithin: 24h}` | Grant now, review afterwards | Infisical bypassers (soft enforcement, ≥10-character reason, `isBreakGlass`); Common Fate SDK `breakglass_reason` |
| `notify: {expiringNotice: 15m (exists), reminderEvery: 1h, escalateAfter, escalateTo: step-or-group}` | Reminder timing is presentation (the flow may use it); **escalation that adds approvers is policy** (see 3.5) | None of the OSS projects does escalation, a gap worth closing |
| `decisionChannels` (exists) + `chatButtons: false` | Equivalent of jitd's `browser_only`: Slack gets a link, never buttons | jitd `WorkflowSlack.BrowserOnly` |
| `disabled` | Stops new requests and decisions; live grants run out on their own | jitd `Disabled` |
| `agents: {eligible, maxDuration: 15m, approverStep: "sponsor", requireSecondPersonForTier: [elevated, privileged]}` | Agent-specific limits (plan §4.2 already says 15 min and the sponsor) | jitd README caveat; Teleport RFD 0238 |

**`access_request`**: add or confirm these fields.

- **Identity:**
  - `requester` (who asked) and `subject` (who gets access).
  - For agents: `actor` (the agent identity), `actingFor` (the person, from the token's `act` chain) and `sponsor`.
  - `source`: portal, slack, mcp, api, landfall.
- **Policy pin:** `policyId` + `policyVersion` + **a snapshot of the resolved steps and eligible approvers at creation**.
  Use the snapshot for "who was asked"; **re-check eligibility at decision time** (JIT Groups, Teleport).
- **Request contents:** `reason`, `ticket {system, id, url}`, `requestedDuration`, `startsAt?`, `decisionDeadline`,
  `extendsGrantId?`.
- **Supersede:** `supersedes?` / `supersededBy?`. A new request for the same bundle and subject closes the older pending
  one (Discord).
- **Auto-approval and break-glass:** `autoApproval? {ruleName, evidence, evaluatedAt}` (Infisical
  `autoApprovalEvidence`) and `breakGlass? {reason, reviewDueAt, reviewedBy?, reviewOutcome?}`.
- **State (a projection):** `status`, `currentStep`, `approvalsCounted`, `closingReason`.

**`decision`** (one row per vote; unique on request + step + decider):
- Keep: decider, outcome, comment, channel, assurance, relayedBy.
- Add `stepIndex`, `submittedBy` (the service that carried it, the Teleport `SubmittedBy` pattern; it generalizes
  `relayedBy`) and `countedAtDecision`.
- When the request is re-read, show the votes that *still* count: a vote from someone who has since lost eligibility
  no longer counts (jitd `ApprovalsCounted`).

**`grant`**: grant state and per-target provisioning state are kept apart (Common Fate SDK).
- **Grant fields:** `status` (`scheduled → active → expired | revoked`), `startsAt`, `activatedAt`, `expiresAt`,
  `closedAt`, `closingReason` (`expired | revoked_by_requester | revoked_by_admin | leaver | policy_disabled |
  superseded_by_extension`), `extensionsUsed`, `isBreakGlass`.
- **`grant_target` rows** (bundle entitlement × target): `status` = `pending → provisioning → provisioned | failed`,
  then `revoking → revoked | revoke_failed`, plus `verified` and `drift`. Also `attempts`, `lastError`, `externalRef`,
  `verifiedAt`, `updatedBy`.
- **Reference counting:** Landbright-side group membership is removed at expiry **only if no other live grant or
  standing membership gives the same group** (Discord). The `MembershipSource` enum already exists, so tag grant
  memberships `source = grant` with the grant id.

**`request_annotation`** (new, small): namespaced key/value on a request or grant, written by a service with
compare-and-swap on a version. For example `landflow.slack.messages = [{channel, ts}]` and
`landflow.run = {executionId}`. Flows can then update the Slack message they posted on decision without a database of
their own (Teleport plugin data with CAS; jitd `SlackMessage`). The phase 2 "Attach wait" (`resumeUrl`) becomes one
annotation (`landflow.wait`).

### 3.3 States and transitions

**Request:**
```
pending ──(all steps met)──────────────▶ approved ──▶ (grant scheduled | active)
pending ──(any eligible denial)────────▶ denied
pending ──(deadline passed; sweeper)───▶ expired
pending ──(requester)──────────────────▶ cancelled
pending ──(newer request, same bundle and subject)──▶ superseded
pending ──(auto-approve rule passes)───▶ approved   [method = auto, evidence kept]
pending ──(break-glass by an eligible requester)──▶ approved   [method = break_glass; review due]
```
- Steps: `pending → in_progress → completed`.
- Auto-approval is an **approval method**, not a separate state. Common Fate's auto-approved requests that stayed
  PENDING is the bug to avoid.

**Grant and grant target:**
```
scheduled ──(startsAt; sweeper)──▶ active ──(expiresAt − notice)──▶ [grant.expiring event]
active ──(expiresAt; sweeper removes the Landbright side)──▶ expired
active ──(admin | requester | leaver | policy disabled)──▶ revoked
active ──(extension approved)──▶ active   [expiresAt moved; extensionsUsed+1; grant.extended]
target: pending → provisioning → provisioned | failed(retryable) ; revoking → revoked | revoke_failed
target: provisioned ──(reconcile flow)──▶ verified | drift
```
- **Every transition is an `access_event`** (principle V). The projection's state is never written directly.

### 3.4 Decision rules (`decide()`): the full list

1. The decider is an active **person** (no agent, no service); spec 003 has this.
2. Not the requester, not the subject, and **not the person an agent is acting for** when the agent requested
   (otherwise "agent asks, I approve" is self-approval; jitd README).
3. Named by the **current step**, through **standing** membership only: memberships with `source = grant` don't make
   anyone an approver (Teleport computes from stored roles, never presented ones).
4. Request pending, before its deadline, policy not disabled, and channel accepted.
5. **One vote per person per request.** A second vote is a no-op, unless the quorum is already met and the grant
   failed (jitd retry).
6. **Denial ends the request immediately**; approval completes the step when `approvalsRequired` distinct people have
   approved; the last step completes the request.
7. Under the per-request advisory lock, as spec 003 has; Infisical uses `FOR UPDATE` the same way.
8. On approval, **clamp the duration** to the current policy max and record that it was clamped.
9. Votes relayed by Landflow (phase 4) carry `submittedBy = landflow` and must still pass 1–6 for the named person.

### 3.5 Auto-approval, escalation and break-glass without breaking principle IV

- **Auto-approve rules are policy a person wrote, evaluated by Landbright.**
  - Facts come from Landbright's directory (groups, HR attributes, identity kind, risk tier) and from first-party
    sources Landbright calls itself. Landfall is the example: "the requester is on call **and** a sev1/sev2 incident is
    open on a matching service", the plan's §4.2 example.
  - The result and its evidence are stored on the request (Infisical). A rule may only *approve*; the opposite is a
    plain eligibility denial.
  - **Facts supplied by Landflow** (for example "the Jira ticket is assigned to the requester") are a later, opt-in
    kind: `evidence {source: landflow, attestedBy: <service>, facts}` posted to the request. A policy can use them only
    if it says `acceptsAttestedFacts: true`, and the decision event records `assurance: attested`. Until then the
    ticket-enrichment flow (F12) only *shows* facts to approvers.
- **Escalation adds approvers; it is policy, not flow logic.**
  - If a step is still pending after `escalateAfter`, the sweeper appends `escalateTo` approvers to that step's
    eligible set, writes `request.escalated`, and the flow messages the new people (F4).
  - Reminders that re-ping the *same* approvers are flow-only (F3). None of the OSS projects has escalation (TEAM, JIT
    Groups and Discord explicitly lack reminders), so this is where Landbright and Landflow can do better.
- **Break-glass.**
  - Only for policies with `breakGlass.allowed`; only for a requester in `breakGlass.eligible`; a reason of at least 10
    characters; `maxDuration` capped (for example 1 h).
  - The grant activates at once with `isBreakGlass`. `request.break_glass` goes out immediately to the step's approvers
    and the security channel (F10), and a review is due within `reviewWithin`.
  - An overdue review shows on Home and raises a Landfall incident.
  - This fits principle IV because the policy, which a person wrote, approves it.

### 3.6 Token lifetime and real revocation (phase 1–2)

TEAM's open sessions and Teleport's certificates show that removing a group doesn't end access already issued.

- **Cap token lifetime at the grant's end.** Any ID or access token whose `roles`/groups claim includes a grant-derived
  group gets `exp ≤ min(normal exp, earliest grant expiresAt among those groups)` (Teleport `truncateTTL`).
- **On early revoke**, revoke the subject's refresh tokens and sessions that carry the role. Emit a CAEP
  `session-revoked`/`token-claims-change` event when SSF lands (principle VI).

### 3.7 Events: changes to spec 003's table

| Event | Status | Why |
|---|---|---|
| `request.created` | keep; **enrich** `data` | Add `approvers[]` with `{id, name, email, slackUserId?}` per step, `decisionUrl`, `deadline`, `approvalsRequired`, `approvalsCounted`, `reason`, `ticket`, `source`, `isAgentRequest`, `sponsor` |
| `request.vote_recorded` | **add** | "1 of 2 approvals": lets the flow update messages and resume its Wait without polling (jitd's `approval` timeline event) |
| `request.escalated` | **add** | New approvers added by policy |
| `request.decided` | keep; `outcome` gains `superseded` and the `method` (`reviewed`, `auto`, `break_glass`) | |
| `request.break_glass` | **add** | Immediate after-the-fact review |
| `grant.activated` | keep; **include `targets[]`** with their status | Provisioning flows loop over targets |
| `grant.target_failed` | **add** | A target recorded `failed`: alert, retry |
| `grant.extended` | **add** | `expiresAt` moved |
| `grant.expiring` | keep; include `actions.extend` and `extensionsRemaining` | |
| `grant.expired`, `grant.revoked` | keep; include `closingReason` and the targets still `provisioned` | |
| `grant.revoke_overdue` | **add** | A target not `revoked` N minutes after the end: page, open a Landfall incident |

Audit (`access_event` types) mirrors these, plus `request.auto_approved` with the rule and evidence,
`decision.refused` (who, why: self, not named, agent, late, already voted), `grant.target_verified` and
`grant.target_drift`.

### 3.8 Machine API for flows (phase 2): additions

Existing in spec 003: `GET /api/v1/requests/:id`, `POST …/waits`, `POST /api/v1/grants/:id/targets/:target`.

**Add:**
- `GET /api/v1/requests/:id` returns `actions` for the *caller*, e.g. `{decide: false}` for Landflow, plus
  `approvalsCounted` and the people who haven't voted (Common Fate `GetAccessRequestActions`).
- `PUT /api/v1/requests/:id/annotations/:key` and `PUT /api/v1/grants/:id/annotations/:key` with `If-Match: <version>`
  (scope `annotations:write`, keys limited to the service's namespace).
- `GET /api/v1/grants?status=active&target=<type>&updatedSince=` for reconciliation (scope `grants:read`).
- `POST /api/v1/grants/:id/targets/:target`: status adds `revoke_failed`, `verified` and `drift`, plus `externalRef` and
  `attempt`. It stays idempotent and is refused unless the grant is in a state that allows it.
- **Preflight:** `POST /api/v1/requests:preview {bundleId, subjectId, duration?}` →
  `{eligible, whyNot?, requiresApproval, autoApproveWouldPass, approvers, maxDuration, defaultDuration, reason,
  ticket, existingGrant?, pendingRequest?}` (Teleport `dry_run`, Infisical `checkPolicyMatch`, Common Fate `BatchEnsure`).
  It is used by the portal form, the Slack intake flow and the agent tool.
- **Idempotent create:** `POST /api/v1/requests` with an `Idempotency-Key`, and "ensure" semantics. An open request or
  live grant for the same bundle and subject is returned, not duplicated (Common Fate overlap check, `BatchEnsure`).
- **Relay create** (later, scope `requests:relay-create`): Landflow files a request *for the person it verified* (a
  Slack-verified email). The subject must be that person, and `source = slack`.

### 3.9 Agents and other non-human identities

- **Agent tools.** Through the Landbright node as an AI tool, or an MCP server later. Five tools, modelled on jitd and
  Discord: `list_requestable` (preflight), `request_access` (idempotent, reason required), `get_access_request`,
  `wait_for_access` (long-poll with a deadline), `cancel_access_request`. **No decide tool exists**, and `decide()`
  refuses any token whose subject is an agent or carries an `act` claim.
- **Agent policy.**
  - Approver step = the **sponsor**, unless the agent acts *for* the sponsor; then the bundle owner or a second person.
  - Elevated or privileged risk tiers always need a second person.
  - `maxDuration` 15 min; decision deadline 15 min.
  - The agent never holds more than its person (principle III), so preflight intersects with the person's eligibility.
- **Service identities** (CI, Landflow itself) don't request JIT access in v1. JIT Groups refuses service accounts
  outright, TEAM is user-only, and Infisical's `bypassForMachineIdentities` is the anti-pattern to avoid.
- **Later: action-level approval** for the riskiest agent tools, i.e. approve one exact statement, bound by its hash
  (hoop `onetime` reviews; Teleport RFD 0238 delegation sessions).

### 3.10 Smaller rules worth copying

- **No state change on GET.** The decision page shows on GET and decides on POST with CSRF protection (Thand's GET
  `/approvals?approved=true` is the counter-example; JIT Groups uses an XSRF header). Decision links carry only the
  request number, not a capability token; the session identifies the approver.
- **Overwrite display fields from the source of truth** before notifying, such as the bundle name and requester name
  (TEAM). A request's `data` snapshot is built by Landbright, never echoed from input.
- **Hide requester attributes** from approver-eligibility expressions (Teleport RFD 0026 "user data leakage").
- **Name each Landflow run after the event**, using the delivery's `webhook-id` as the idempotency key (Landflow already
  does this). Name downstream calls after the grant target, so retries are harmless (TEAM, Common Fate).
- **Expiring-access digests** for long grants (owners: this week and next; users: tomorrow; skip on "do not renew";
  Discord) alongside the 15-minute `grant.expiring`.
- **A `disabled` bundle or policy** stops new requests and decisions; live grants run out (jitd).
- **Read-back verification:** after provisioning and after revoking, check the target and record `verified` or `drift`
  (jitd, JIT Groups compliance).

## 4. The Landflow flows that should exist

The user's rule is that approval, provisioning, revocation, notification and escalation are Landflow flows. Every flow
below uses Landflow's generic nodes, checked in `landflow/apps/web/src/lib/server/nodes/`: **Webhook** (with *Raw
Body*), **Schedule Trigger**, **Error Trigger**, **HTTP Request** (credential `core.oAuth2Api`, client credentials
against Landbright), **Code**, **If**, **Switch**, **Filter**, **Merge**, **Loop Over Items**, **Wait** (webhook resume,
*Limit Wait Time*), **Execute Workflow**, **Send Email**, **Slack**, **Respond to Webhook**, **Stop and Error**.

**Two ways in.**
- **Generic (works today):** a Webhook node whose URL an administrator registers in Landbright as a subscription.
  - A **Code** node verifies Standard Webhooks: HMAC-SHA256 of `webhook-id.webhook-timestamp.rawBody` with the secret,
    a 5-minute window, and accepting any `v1,` signature during rotation. On failure it goes to **Stop and Error**,
    with a 401 from **Respond to Webhook**.
- **Plugin (spec 003 phase 3):** the **Landbright Trigger** does the subscription and verification, and the
  **Landbright** node replaces the HTTP Request calls.

The steps are the same either way.

**Common prelude**, used as the start of every event flow (call it **P**):
1. Verify the signature.
2. **Switch** on `type`.
3. **HTTP Request** `GET /api/v1/requests/:id` or `/grants/:id`: the re-read. Snapshots can be late or duplicated.
4. **If** the re-read state still matches what this flow handles; otherwise stop.

| # | Flow | Trigger | Steps | Calls back to Landbright |
|---|---|---|---|---|
| F1 | **Request intake from Slack** (optional) | Webhook (Slack slash command `/access <bundle> <duration> <reason>`) | Code (verify Slack signature, parse) → HTTP `POST /api/v1/requests:preview` → If eligible → HTTP `POST /api/v1/requests` (relay create, `Idempotency-Key` = Slack trigger id) → Respond to Webhook (ephemeral: "REQ-128 sent to Dana and Lior, decide by 14:30"), or the preview's `whyNot` | preview, relay create (later scope) |
| F2 | **Approval conversation** | `request.created` | P → HTTP `PUT …/annotations/landflow.run` → **Loop Over Items** (`approvers[]` of the current step) → Switch on contact → **Slack** DM or **Send Email** with the decision link (`decisionUrl`; no buttons unless the policy allows chat) → Code collects `{channel, ts}` → HTTP `PUT …/annotations/landflow.slack.messages` → HTTP `POST …/waits {resumeUrl: $execution.resumeUrl}` → **Wait** (webhook POST, limit = `deadline` + 2 min) → HTTP `GET request` → **Switch** on `status`: *pending* → update the messages ("1 of 2 approved"), loop back to Wait; *approved / denied / expired / cancelled / superseded* → hand to F5 (or end; F5 also runs from `request.decided`) | annotations, waits; reads only. **Never decides.** |
| F3 | **Remind approvers** | `request.created` | P → **Wait** (`reminderEvery`, e.g. 1 h; from `data.policy.notify`) → HTTP `GET request` → If still pending → Code: approvers who haven't voted → Slack or Email reminder (in thread, using `landflow.slack.messages`) → loop until the deadline | read only |
| F4 | **Escalation messaging** | `request.escalated` | P → Loop Over the `addedApprovers` → Slack DM or Email with the decision link and "escalated after 30 min without a decision"; optional HTTP to Landfall to page on-call when the step is `oncall` | read only |
| F5 | **Decision notice** | `request.decided` | P → **Switch** on `outcome`: approved (with start time) / denied (comment) / expired / cancelled / superseded → Slack or Email to the requester (for an agent request, to the sponsor, and to the agent's run if it is waiting) → HTTP to the Slack API `chat.update` for each message in `landflow.slack.messages` ("Approved by Dana at 14:02") | read only |
| F6 | **Provision a grant** | `grant.activated` | P (re-read the grant; If `active`) → **Loop Over Items** (`targets[]` where `status` ∈ pending, failed) → **Switch** on `target.type` → **Execute Workflow** "Provision ‹type›" (F7) → **If** ok → HTTP `POST /grants/:id/targets/:t {status: provisioned, externalRef}`; else HTTP `{status: failed, detail, attempt}` → **Wait** back-off (1, 5, 15 min) → retry up to N → Slack to requester and bundle owner on final failure | grant target status |
| F7 | **Per-target provision / revoke** (one sub-flow per target type: Landflow project role, GitHub team, Postgres role, Google group, …) | Execute Workflow (called by F6, F9, F11) | Input `{action: provision\|revoke\|check, grantId, subject (with mapped external id), target, expiresAt}` → HTTP or DB nodes to the target, **idempotent** (add-if-missing / remove-if-present; label the change with the grant id) → for `check`, read back → output `{ok, externalRef, present}` | none (the caller reports) |
| F8 | **Expiry warning and extension offer** | `grant.expiring` | P → If `actions.extend` and `extensionsRemaining > 0` → Slack or Email to the subject (agent: its sponsor) with "Extend by 1 h" linking to the portal's extension form (an extension is a request; the decision stays in Landbright) → else a plain "ends at 16:00" | read only |
| F9 | **Revoke a grant** | `grant.expired`, `grant.revoked` | P → Loop Over `targets[]` with status provisioned or revoke_failed → Execute Workflow F7 `revoke` → HTTP `POST …/targets/:t {status: revoked}` or `{revoke_failed, detail}` → Wait back-off and retry (Landbright also re-sends `grant.expired` until each target is revoked) → Slack to the requester: "access to ‹bundle› ended (expired / revoked by Dana)" | grant target status |
| F10 | **Break-glass review** | `request.break_glass` | P → Slack to the security channel **and** the step's approvers ("Tal used break-glass on Prod DB: ‹reason›, until 15:00") → Email to the bundle owner with the review link (Landbright portal) → **Wait** until `reviewDueAt` → HTTP `GET request` → If not reviewed → HTTP to Landfall: open an incident, then Slack the security lead | read only |
| F11 | **Overdue revocation** | `grant.revoke_overdue` | P → HTTP `POST` to Landfall (create incident: grant, target, last error) → Slack to the platform on-call → Execute Workflow F7 `revoke` once more → HTTP target status | grant target status |
| F12 | **Reconcile targets (drift)** | **Schedule Trigger** (hourly per target type) | HTTP `GET /api/v1/grants?status=active&target=‹type›` → Loop → Execute Workflow F7 `check` → **If** present → HTTP `{status: verified}`; else `{status: drift}` → separately, Code lists downstream members with no active grant or standing entitlement → Slack summary to the bundle owner (remove only if the target's policy says Landbright is authoritative, as in Discord's `--authoritative` mode) | grant target status |
| F13 | **Ticket enrichment** (presentation; later, attested evidence) | `request.created` where `ticket` is set | P → HTTP to Jira / Landfall: fetch the ticket → Code summarizes (status, assignee = requester?, project) → HTTP `PUT …/annotations/landflow.ticket` (shown on the decision page). Later, with `acceptsAttestedFacts`: HTTP `POST …/evidence` | annotations (later: evidence) |
| F14 | **Delivery health** (Landflow side) | **Error Trigger** for F2–F13 | Slack to the flow owner with the failed node and execution link → HTTP `PUT …/annotations/landflow.lastError` on the request or grant so the console timeline shows it | annotations |

**Templates to ship** (spec 003 phase 3, `plugins/landbright/flows/`):
- **F2 + F3 + F5** as "Approve a request (email)" and "Approve a request (Slack)".
- **F6 + F9 + F7** (Landflow project role) as "Provision and revoke a Landflow project role".
- **F8**, **F11** and **F12** as small templates.
- F1, F10 and F13 come with the matching Landbright features.

**What no flow can do:**
- approve or deny (there is no route for it until phase 4's relayed decisions, and those name and verify a person);
- change who may approve or how many (that is policy);
- extend a grant (extension is a request);
- end access early on the Landbright side (the sweeper does that whatever the flow does).

## 5. Suggested edits to spec 003, in order

1. **Phase 1:**
   - Policy `steps[]` (one step in v1), deny-wins, approver fallback and refuse-if-nobody, `reason {mode, prompt}`,
     typed `ticket`, duration clamp, `disabled`.
   - Request `subject` / `actor` / `actingFor` / `source`, policy snapshot, `supersedes`.
   - Grant targets with separate provisioning state.
   - Reference-counted group removal.
   - `decide()` rules 1–9 (§3.4), including "standing membership only" and "not the person an agent acts for".
   - Token `exp` capped at grant end.
2. **Phase 1 (small):** `startsAt` scheduling; extension policy and `grant.extended`; preflight (`requests:preview`);
   idempotent create / overlap check.
3. **Phase 2:**
   - Events `request.vote_recorded`, `request.escalated`, `request.break_glass`, `grant.target_failed`,
     `grant.extended`, `grant.revoke_overdue`; enriched `request.created`.
   - Annotations API with CAS; `GET /grants?…` for reconciliation; target statuses `revoke_failed`, `verified`, `drift`.
4. **Phase 2–3:** auto-approve rules over Landbright-owned facts plus the Landfall on-call/incident check, with evidence.
   Escalation in policy, applied by the sweeper. Break-glass with after-the-fact review.
5. **Phase 3 (Landflow spec):** templates F2/F3/F5, F6/F7/F9 and F8; F11/F12 next; F1, F10 and F13 with their features.
6. **Later:** attested evidence from Landflow (`acceptsAttestedFacts`); relayed create from Slack; agent tools over MCP;
   action-level approvals for risky agent tools; Cedar or CEL for conditions if the plain-JSON conditions outgrow
   themselves. JIT Groups (CEL) and the Common Fate SDK (Cedar) show the two options, and principle I suggests adopting
   one rather than inventing a language.

## Appendix: clone locations (read-only)

All under `(session scratchpad, not kept)/jit-oss/`:

- `jit-access`, `team`, `teleport` (sparse), `tp-hist` (teleport-plugins history at `8e802fc`), `teleport-plugins`
  (archived stub), `infisical` (sparse: approval-policy, delegated-approval, schemas)
- `thand`, `discord-access`, `common-fate`, `cf-sdk`, `tailscale-jit`, `hoop`, `abbey`
