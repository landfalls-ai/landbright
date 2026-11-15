# Plan 008

[Spec](spec.md) · [Tasks](tasks.md).

## Contracts (`libs/contracts/src/access.ts`)

- `BundleTarget.cost`: optional `{ kind: 'seat', landbrightApp }` (`landbrightApp`: lowercase letters, digits and
  `. _ -`, up to 80, as Landledger's examples). Optional, so every stored target still parses.
- `ApprovalStep.kind`: `'people'` (default) or `'external'`; for `external`: `settledBy` (a client id), `system` (a
  name people read), `deadlineMinutes` (default 1440). Old policies parse as `people` steps.
- `SettleStep`: `{ outcome: 'approve' | 'deny', reference: { system, id, url? }, reason? }`.
- `AccessRequestView`:
  - each step gets `kind`, `system`, `settledBy` and `settlement` (`{ outcome, reference, reason, by, at }` or null);
  - the request gets `waitingOnSystem` (the system's name while its step is current) and `costs`
    (`[{ target, label, kind, landbrightApp }]`, from the bundle).
- `MACHINE_API_SCOPES['steps:settle']`.

## The policy's rules (checked when a bundle is saved)

At most one external step; it is step 1; at least one people step follows. `settledBy` names an application in the
tenant that is not an agent's (an agent never decides, principle IV) and not Landbright's console.

## Requests (`access.service.ts`)

- `plan()`: an external step's snapshot carries `kind`, `settledBy`, `system`, `deadlineMinutes` and no approvers; the
  short-of-approvers check and the preview's approvers look at people steps only.
- `file()`: with an external first step, the deadline is now + its `deadlineMinutes`. An auto-approve rule that matches
  is kept on the gate's snapshot (`autoRule`, `evaluatedAt`) instead of approving now. Break-glass approves at once, as
  today. `request.created` data gets `costs` (the `landbrightApp`s).
- `settle(service, id, step, input)`: under the request's lock.
  - The step must exist and be external, and the caller's client id must be its `settledBy` (otherwise 403).
  - Already settled: the same outcome and reference id answer 200; anything else, 409.
  - Request not pending: 409 saying why (break-glass: *its cost step was skipped*).
  - Approve: the settlement goes on the snapshot, the next step starts (`startedAt`), the deadline becomes now + the
    policy's `decisionDeadlineMinutes`; `request.step_settled`, then `request.step_started`; with a kept `autoRule`,
    approved by it (`method: auto`, the evidence says after which step).
  - Deny: `denied`, closing reason `step_denied`; `request.step_settled`, then `request.decided`
    (`outcome: denied`, `by: system`).
- `castVote()`: moving to the next step sets its `startedAt` and audits `request.step_started`.
- `whyNotDecide()`: on an external step, *This step is settled by Landledger, not by a vote.*
- `relayTickets()`: refused on an external step (it never allows relayed votes).
- The sweeper:
  - escalation skips an external step and counts from the step's `startedAt` (else the request's creation);
  - expiry is unchanged (the deadline column already holds the right time); the audit names the step that ran out.
- Events: `request.step_settled` and `request.step_started` are event types and wake waiting runs.

## Flows and installer

*Approve a request (email)* and *(Slack)* start on `request.step_started` as on `request.created` (the event code
passes both; the request is re-read, and its `waitingOn` asked). The installer subscribes both to it. Landflow's
application gets `steps:settle` (the Landledger flow runs in the same Landflow and settles as it).

## Console

- Catalog: *Add a cost gate* puts an external step first (application, name, system, deadline in hours); the step list
  shows it as *Settled by Landledger*. A target with a seat cost shows *seat · linear*.
- Request page: the gate as a step card, *Waiting on Landledger* or *Approved by Landledger · LL-123* with the link;
  *Decide by* is the gate's deadline while it waits.

## Design review: the claims, against the source (2026-11-15)

| Claim | Checked | Where |
|---|---|---|
| Landledger finds the contract by `landbrightApp` and answers `{ contract, seatPrice, left }`, 404 when none | ✓ | landledger `apps/api/src/wave3-routes.ts:101`, `contracts.ts:447` (`seatsFor`) |
| Landledger takes `origin.breakGlass` and lists those requests as exceptions until approved | ✓ | landledger `apps/api/src/exceptions.ts:150` |
| Policies and the steps a request named are JSON (no migration for new step fields) | ✓ | `access.service.ts` `file()` (`policySnapshot`, `approvers`); schema `access_request` |
| Expiry reads the `deadline` column only | ✓ | `access.sweeper.ts:25` |
| Escalation counts from `createdAt` and adds to the current step | ✓ | `access.sweeper.ts` `escalate` |
| A service's client id is on its principal; an agent's application has `agentId`; the console's is `system` | ✓ | `common/principal.ts`, schema `OidcClient` |
| Scopes are a fixed map and an application holds a subset | ✓ | `libs/contracts/src/machine-api.ts`, `OidcClient.apiScopes` |
| Waiting runs are woken on certain request actions only | ✓ | `event-worker.ts:20` (`WAKE_ACTIONS`) |
| The approval flows ask only on `request.created` (so only step 1's approvers) | ✓ | `approve-request-by-email.json` (*Request created?*), `approve-request-by-slack.json`; installer subscriptions |
| Targets are edited as JSON in the console, so `cost` needs no new input | ✓ | `apps/console/src/routes/catalog.tsx` (*Targets (JSON)*) |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt plumbing | PASS | No new protocol; the machine API's client credentials and scopes |
| II. Default deny | PASS | `steps:settle` is a new scope nobody has until given; only the named application may settle; settling is refused off the external step, after a decision, or twice with a different answer |
| III. Accountable human | PASS | The gate's application is one an administrator configured on the bundle; agents' applications can't be named |
| IV. Policy or a person approves | PASS | A system's step can only deny or pass the request on: a people step must follow, and they decide access. A system's answer is never a person's vote |
| V. Ledger | PASS | `request.step_settled` (with Landledger's reference), `request.step_started`, `request.decided` |
| VI. Standards | PASS | OAuth 2.0 client credentials; no new wire format beyond the zod contracts |
| VII. N-up safe | PASS | Settling under the request's advisory lock; repeating the same settlement is 200 |
| VIII. Spec-driven | PASS | Unit tests (policy rules), e2e (gate, auto, break-glass, extension, escalation, wrong caller), browser screens |
| IX. Local only | PASS | Fictitious people and a fictitious *linear* seat; Landledger's side is its session's to build |
