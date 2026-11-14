# Plan 006

[Spec](spec.md) · [Tasks](tasks.md).

## Data (migration `20261117090000_provisioning`)

- `scim_target`: name, `base_url`, `token_sealed` (AES-GCM with `LANDBRIGHT_SECRET_KEY`, `seal()`), `groups_mode`
  (`groups` | `user_attribute`), `group_ids` (the assigned Landbright groups), `client_id` (the OIDC application, optional),
  `disabled`, `cursor` (the last audit event read), `last_reconciled_at`, `last_success_at`, `last_error`.
- `scim_link` (target, kind `user` | `group`, local id) → `remote_id` and `state`: what was last pushed (`userName`,
  `active`, `groups` for a user; `displayName`, `members` as remote ids for a group).
- `scim_job` (target, kind, local id): queued work, one row per object however many changes; `attempts`,
  `next_attempt_at`, `last_error`, `verify` (reconciliation: read the application's copy first).

All three under row-level security like every tenant table.

## The sync

`ScimSync`, run from the event worker's loop (2 s, one replica at a time under its Valkey lock):

1. **Match.** For each enabled target, audit events after its cursor become jobs: `identity.*` → that person;
   `group.member_added` / `group.member_removed` → the person, and the group (groups mode); `group.updated` → the group
   (and its members, in user-attribute mode); `group.deleted` → the group and everyone linked. The cursor moves in the
   same transaction.
2. **Reconcile** a target every 15 minutes, or when it changed or *Sync now*: every person in scope, every linked
   person, every assigned or linked group, as `verify` jobs.
3. **Push** due jobs: people before groups, in parallel across targets, in order within one.

A person: in scope = a `person`, `active`, in an assigned group. Desired: `userName` = email, `externalId` = their id
(the ID token's `sub`), `displayName`, `name`, `emails` (work, primary), `active`, and in user-attribute mode `groups` =
their assigned groups' names.

- Not linked, in scope: `POST /Users`. 409 → `GET /Users?filter=userName eq "<email>"` (then `externalId eq`) and
  adopt it with a `PATCH`.
- Linked, last pushed active, still in scope: `PATCH` with `replace` of what changed (`active` with a path, the rest
  as a path-less value; `groups` with a path).
- Linked, last pushed inactive, back in scope: `POST` again (Landfall re-links its identities only on create), with the
  same 409 fallback (Landflow).
- Linked, out of scope: `PATCH active: false`.
- 404 on a linked user: the link is dropped and the person created again.
- `verify`: `GET /Users/:id` first and compare `active` and `userName` with what should be.

A group (groups mode), members = the remote ids of its linked, in-scope members:

- Not linked: `POST /Groups` with `externalId`; 409 → `GET /Groups?filter=displayName eq` and adopt.
- Linked: `GET /Groups/:id` (or the last pushed state), then `PATCH` with `add` / `remove` of members and `replace` of
  `displayName`. 404 → recreate.
- Unassigned or deleted in Landbright: `DELETE /Groups/:id`, link dropped.
- A person pushed, deactivated or reactivated queues their groups.

The client: `Authorization: Bearer`, `Content-Type: application/json` (Landfall's body parser takes no
`application/scim+json`), `Accept: application/scim+json, application/json`, 10 s timeout, no redirects. 429, 5xx and
network errors retry with back-off (5 s doubling, an hour at most; `Retry-After` honored); other errors too, shown on the
target. Responses are read only for `id`, `active`, `userName`, `members`.

## API and console

- `GET/POST /api/provisioning/targets`, `GET/PATCH/DELETE /api/provisioning/targets/:id`, `PUT …/:id/token`,
  `POST …/:id/sync`, `POST …/:id/test`. Administrators only (the console session), like Applications.
- Console → **Provisioning** (under Connect): targets with their state (in sync, pushing, failing), people and groups
  pushed, last sync; *Add target*; a target's page with who is pushed (remote id, active, when) and what is queued or
  failing.
- Audit: `provisioning.target_created` / `_updated` / `_deleted` / `_token_replaced`, `provisioning.user_created`,
  `provisioning.user_updated`, `provisioning.user_deactivated`, `provisioning.user_linked`,
  `provisioning.group_created`, `provisioning.group_updated` (members added and removed, with the grants behind them),
  `provisioning.group_deleted`, `provisioning.push_failed` (the first failure of a job).

## Design review: the claims, against the servers' source (2026-11-14)

| Claim | Landflow (`~/WorkSpace/landflow`) | Landfall (`clickland-integration`) | Clickland |
|---|---|---|---|
| Base URL and token | `/scim/v2`, a `scim`-only API key made by an admin's session (`app/api/api-keys/route.ts:26-38`) | `/scim/v2/:org`, `POST /o/:org/scim/enable` returns it once (`scim-admin.controller.ts:70-77`) | Being built (Clickland session, 2026-11-14): `/scim/v2` on :4710 |
| `active:false` ends sessions | Session rows deleted in the request (`lib/server/auth/users.ts:262-272`) | Membership deprovisioned, OpenFGA tuples deleted: org routes refuse at once; its 1-hour session JWT isn't revoked (`scim.service.ts:393-446`) | Promised: sessions end at once |
| Existing account | 409 `uniqueness` on userName or externalId; filters `userName eq`, `externalId eq` work (`scim/users.ts:149-150`, `filter.ts`) | POST is create-or-link, never 409 (`scim.service.ts:206-218`); filter `userName eq` only | — |
| Groups | Stored; `members[].value` = `usr_` ids, unknown ids dropped silently; map by name (`scim/groups.ts:69-158`) | Not stored; a role chosen from the user's `groups` (`scim.service.ts:711-759`) | Both forms |
| Sign-in link | By `(iss, sub)`, then email (`auth/oidc.ts:308-314`) | `externalId` must equal the ID token `sub` (`scim.service.ts:179-195`) | — |
| Updates | `PATCH` with `replace`; `emails` writes ignored, so email changes go by `userName` (`scim/users.ts:184-224`) | `PATCH` reads only `active` and `groups`; others answer 200 and do nothing | — |
| Reactivation | `PATCH active:true` | `PATCH active:true` loses the identity link; `POST` re-records it (`scim.service.ts:327-354`) | — |

So: one client, with `groups_mode` the only difference; `POST`-first reactivation; userName-then-externalId lookup;
`application/json`. Landfall's 1-hour JWT is its own limit (recorded in limitations).

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt plumbing | PASS | SCIM 2.0 (RFC 7643/7644) as the servers already speak it; no SCIM library is needed for a client this small; the outbox and back-off are the event worker's |
| II. Default deny | PASS | Only people in assigned groups are pushed; out of scope means `active:false`; tokens sealed and write-only; administrators only |
| III. Accountable human | PASS | An administrator assigns groups to a target; every push is attributed to it in the ledger |
| IV. Policy or a person approves | PASS | Provisioning carries out what a person or a policy already decided (a membership); it decides nothing |
| V. Ledger | PASS | `provisioning.*` audit events for every change pushed and every first failure |
| VI. Standards | PASS | SCIM 2.0; OpenID Back-Channel Logout 1.0 in slice 2 |
| VII. N-up safe | PASS | Jobs and links in Postgres; one worker at a time under the Valkey lock; cursors move with the jobs they made |
| VIII. Spec-driven | PASS | e2e `provisioning.test.ts` against two fake servers (a Landflow-like and a Landfall-like one); unit tests for the operations; the live check against the throwaway Landflow |
| IX. Local only | PASS | Targets on 127.0.0.1: the throwaway Landflow (`landbright-landflow`), Landfall's and Clickland's local servers |
