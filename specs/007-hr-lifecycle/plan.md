# Plan 007

[Spec](spec.md) · [Tasks](tasks.md).

## Where the plugins live (a change to plan §3.3 and §3.4)

The wave plan puts both plugins in the Landflow repository. They go in this one instead, under
`integrations/landflow/plugins/{hris,landbright}`, next to the flows in `integrations/landflow/flows`:

- Landflow plugins are separate processes that announce themselves to a host ([Landflow protocol §1](../../../landflow/docs/protocol.md));
  nothing about a plugin has to be in Landflow's tree, and Landbright's rules say to change Landflow only when asked.
- What they speak is Landbright's API and HiBob's, so they change with Landbright.
- They use `@landflow/sdk` from the Landflow checkout next to this one (`link:`, as the SDK is private), so they follow
  the SDK as it is, and they can move into Landflow's `plugins/` unchanged if the user wants them there.

They are TypeScript (the SDK's), run with `tsx`, and their tests are vitest. They are not built into Nx's `verify`
the way the services are; they get their own `typecheck` and `test` targets, which `verify` runs.

## Data (migration `hr_sources`)

- `source_link` (tenant, `identity_id` → identity, cascade; `source` text: `hibob` today; `source_id`; `last_seen_at`;
  `last_values` json: the worker as last received). Unique (tenant, source, source id), and one link per identity and
  source. Under row-level security.

`pre_hire` and `person_profile.start_date` already exist; nothing used them.

## API

`POST /api/v1/people` (`directory:write`): `UpsertWorker`:

| Field | |
|---|---|
| `source`, `sourceId` | Required: `hibob` and the employee id |
| `email`, `givenName`, `familyName` | Required; `displayName` defaults to the two names |
| `department`, `title`, `site`, `managerEmail` | Optional; null clears |
| `startDate`, `endDate` | ISO dates, optional |
| `sendInvite` | Default true: the invite goes when they become active (now, or on their start date) |

1. Found by its source link: updated (profile fields; the email too, unless another person has it: 409).
2. Else a person with that email: linked, then updated (`identity.linked_to_source`).
3. Else created: `pre_hire` when `startDate` is after today (UTC), else `active` (with the invite).
4. A deactivated person is not brought back (409: reactivating is a person's decision in the console).
5. A pre-hire whose start date is now today or past is activated at once (as the sweeper would).

Answers `{ person, created, linked, changed: string[] }`, 200 or 201. Every change audited with the application as
actor and `source` in the data: `identity.created`, `identity.updated` (the fields), `identity.linked_to_source`.

**Start dates.** The access sweeper, in the event worker's loop, activates pre-hires whose `start_date` ≤ today (UTC):
status `active`, `identity.activated` (`{ startDate, source }`), and the invite email if they have no password and
`sendInvite` was asked (kept on the link's `last_values`). `identity.*` events already queue SCIM pushes, so they reach
Landflow then.

The console: the person's page shows the source (*From HiBob · employee 3332…*) and, for a pre-hire, *Starts 21 Nov*;
the People list's status column already says *Pre-hire*.

## The hris plugin (`hris`, HTTP :7141, gRPC :7241)

- **HiBob API** credential: `baseUrl` (default `https://api.hibob.com/v1`), `serviceUserId`, `token` (password),
  `webhookSecret` (password). Test: `POST /people/search` with `fields: ["root.id"]` and a filter on an email that
  can't exist (a 200 is enough; HiBob has no cheaper authenticated call).
- **HiBob Trigger** (`hris.hibobTrigger`, `triggerSource: appWebhook`): `create` tests the credential and keeps the URL
  (Bob has no subscription API: the user pastes it into Bob's webhook settings); `checkExists` true while the URL is
  unchanged; `delete` clears it. `webhook`: a ping (`Ping test` or `{"text":"Ping test"}`) gets 200 and starts
  nothing; anything else needs a valid `Bob-Signature` (base64 HMAC-SHA512 of the raw body with `webhookSecret`,
  constant time) or gets 401; event types filtered by the node's *Events* (default the joiner, mover and leaver ones);
  *Fetch Employee* (default on) reads the employee and outputs the worker; idempotency key `type:employeeId:triggeredAt`.
- **HiBob** (`hris.hibob`): Employee → Get (by id or email), Search (by email; *Include inactive*), each as a worker.
- **The worker** (`src/worker.ts`): reads a HiBob employee in either of its shapes (the machine format's flat
  `"/root/email": { "value": … }`, or nested `root.email`), and maps `root.email`, `root.firstName`, `root.surname`,
  `root.displayName`, `work.department`, `work.title`, `work.site`, `work.reportsTo.email`, `work.startDate`,
  `internal.terminationDate`, `internal.status` / `lifecycleStatus`. `changedFields` from `fieldUpdates` or
  `fieldUpdatesIds` (the docs use both).
- Rate limits: a 429 is retried after `Retry-After` (at most twice), then fails the item.
- `test/fake-hibob.ts`: a Bob with a few employees (`POST /people/:id`, `/people/search`, Basic auth checked) and
  `deliver(url, event)`, which signs as Bob does. The live check uses it too: there is no HiBob tenant here.

## The landbright plugin (`landbright`, HTTP :7142, gRPC :7242)

- **Landbright API** credential: `controlUrl`, `issuer`, `clientId`, `clientSecret`, `scopes` (default `directory:read
  directory:write`: Landbright grants only the scopes asked for, found in the e2e). Tokens by client credentials with
  `resource=urn:landbright:api`, cached until a minute before they expire. Test: get a token.
- **Landbright** (`landbright.landbright`): Person → *Create or update from a worker* (the input item, or fields),
  *Get*, *Deactivate* (`reason`); Group → *Add member*, *Remove member* (by group name or id), *Get by name*. Errors
  carry Landbright's message; *Continue on fail* as everywhere.

## The Joiner flow (`integrations/landflow/flows/joiner-hibob.json`)

HiBob Trigger (`employee.created`, `employee.joined`, `employee.updated` off in slice 1) → Landbright: Person → Create or
update. Birthright groups stay with the *Onboard* flow (`identity.created`), so the map is in one place. The installer
creates the two credentials when the plugins are online (`HIBOB_*` variables; the live check points them at the fake
Bob) and skips the flow otherwise.

## Design review: the claims, against the source (2026-11-14)

| Claim | Checked | Where |
|---|---|---|
| A remote plugin can be an app-webhook trigger with static data, credentials and an idempotency key | ✓ | Landflow `docs/protocol.md` §12; `packages/sdk` `webhookMethods`, `webhook(ctx)` |
| A service with no subscription API: `create` only checks the credential, the user pastes the URL | ✓ | protocol §12 (the Slack Trigger in `plugins/messaging`) |
| The SDK is usable from this repository | ✓ | a probe package with `link:` to `landflow/packages/sdk` typechecks and runs under `tsx` |
| The throwaway Landflow can reach plugins on the host and needs no registry secret | ✓ | `deploy/landflow/compose.yml`: host networking, `LANDFLOW_PUBLIC_URL=http://localhost:57300`, development profile; Landflow `auth/guard.ts:86` asks for the secret only when set |
| A pre-hire can't sign in | ✓ | `login.service.ts:44`, `oidc/account.ts:19`, `passkey.service.ts:173`: `status: 'active'` |
| SCIM pushes only active people, and on `identity.*` | ✓ | `scim-sync.ts` (in scope = active, in an assigned group) |
| The machine API can't create a person yet | ✓ | `machine.controller.ts` |
| Bob: `Bob-Signature` = base64 HMAC-SHA512 of the body; a ping `{"text":"Ping test"}` wants 200; v2 payload `{companyId, type, triggeredBy, triggeredAt, version, data: {employeeId}}`; `fieldUpdates` / `fieldUpdatesIds` (both in the docs); `POST /v1/people/{id or email}` and `/v1/people/search` answer `{ employees: [...] }`, machine format with `/root/…` keys and `value`; Basic auth with a service user; retries for 3 days, 10 s timeout | ✓ (docs, re-read today) | apidocs.hibob.com: getting-started-webhooks, employee-events-v2, post_people-identifier, post_people-search, authorization |
| Bob fires lifecycle events at midnight in the site's time zone on the effective date | From research.md | same pages (re-read in wave 3's research) |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt plumbing | PASS | Landflow's SDK and its webhook machinery; HiBob's documented signature; no HR library |
| II. Default deny | PASS | `directory:write` only; deliveries without a valid signature start nothing (401); a pre-hire can't sign in and isn't pushed; a deactivated person isn't revived by HR |
| III. Accountable human | PASS | HR is the source of record for joiners; every change is attributed to the Landflow application with `source` |
| IV. Policy or a person approves | PASS | Birthright groups are standing access by policy (the Onboard map), the one exception the plan names; nothing here decides a request |
| V. Ledger | PASS | `identity.created` / `updated` / `linked_to_source` / `activated`, with the source |
| VI. Standards | PASS | OAuth 2.0 client credentials with resource indicators; HiBob's HMAC as documented |
| VII. N-up safe | PASS | The source link's unique key makes a redelivery update, not duplicate; activation under the worker's lock; Landflow dedupes by the idempotency key |
| VIII. Spec-driven | PASS | Plugin unit tests against the fake Bob; e2e: the plugins' nodes against the built stack; the live check in the throwaway Landflow |
| IX. Local only | PASS | A fake Bob on 127.0.0.1; no HiBob tenant, no real HR data; fictitious people |
