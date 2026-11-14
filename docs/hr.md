# People from HR

Wave 3, first slice ([spec 007](../specs/007-hr-lifecycle/spec.md), [plan](../specs/007-hr-lifecycle/plan.md)).
HiBob says someone was hired; Landflow runs the *Joiner* flow; Landbright creates them as a **pre-hire** with their
department, title, site, manager and start date. They can't sign in, aren't pushed to applications and get no invite
until their start date. On it they become active, the invite email goes, and SCIM puts them in Landflow (and the other
targets) with the groups the *Onboard* flow gave them.

```
HiBob ──signed event──▶ Landflow: HiBob Trigger (hris plugin) ──worker──▶ Landbright node (landbright plugin)
                                                                              │ POST /api/v1/people
                                                                              ▼
                        Landflow: Onboard flow ◀── identity.created ── Landbright: pre-hire ── start date ──▶ active,
                        (birthright groups)                                                      invite, SCIM push
```

## In Landbright

### `POST /api/v1/people` (`directory:write`)

Creates, links or updates a person from an HR record, keyed by the record's **source and id** (`hibob` and the
employee id). See [reference/api.md](reference/api.md#machine-api-apiv1) for the fields.

1. **Found by its source link:** updated (names, department, title, site, manager, dates; the email too, unless someone
   else has it: 409).
2. **Else someone with that email:** linked to the record, then updated (`identity.linked_to_source`). An agent or a
   service with that email is a 409.
3. **Else created:** `pre_hire` when `startDate` is after today (UTC), otherwise `active` with the invite.
4. **A deactivated person isn't brought back** (409): reactivating is a person's decision, in the console.
5. **A pre-hire whose start date has come** is activated at once (`identity.activated`), with the invite.

The answer is `{ person, created, linked, changed }` (201 when created, else 200); `changed` names the fields that
moved, so a redelivery answers `changed: []` and records nothing but the time it was seen. The manager is found by email
among active people; an unknown one is left out. Every change is in the ledger with the application as actor and
`source` in the data.

### Start dates

The event worker (every 2 seconds, one replica per tenant) activates pre-hires whose start date is today or past (UTC):
status `active`, `identity.activated` (actor *Start dates*), and the invite email when they have no password and the
record didn't say `sendInvite: false`. `identity.*` events already queue SCIM pushes, so the applications hear of them
then, not before.

A pre-hire can be given required actions (the *Onboard* flow asks for a second step and the terms at the first sign-in),
but not emailed about them before they start (`notify` is a 409 for a pre-hire).

### The console

The person's page shows the start date, with *can sign in from then* for a pre-hire, and **From**: *HiBob · employee
3332…* ([screen 90](screens.md)). The People list says *Pre-hire* in the status column ([screen 91](screens.md)).

## In Landflow: two plugins

Both are remote Landflow plugins in this repository (`integrations/landflow/plugins/`), written with Landflow's SDK
(`@landflow/sdk`, linked from the Landflow checkout next to this one). They announce themselves to a Landflow host and
change nothing in Landflow. Their tests run in `pnpm verify` (`typecheck` and `test` of each).

### hris (HTTP :7141, gRPC :7241)

- **HiBob API** credential: base URL (default `https://api.hibob.com/v1`), service user id and token (Basic auth), and
  the webhook's signing secret. *Test connection* runs a search that matches nobody.
- **HiBob Trigger** (an app webhook). HiBob has no API to register a webhook, so publishing only checks the credential
  and the Publish menu shows the URL to paste into Bob (*Settings → Integrations → Automation → Webhooks*, events v2).
  Each call: Bob's *Test* ping (`Ping test`, as text or `{"text":"Ping test"}`) gets 200 and starts nothing; anything
  else needs a valid `Bob-Signature` (base64 HMAC-SHA512 of the body) or gets 401; event types not chosen are answered
  and ignored; with *Fetch Employee* (on by default; Bob's event carries only an id) the employee is read and the item
  is the **worker**. When the employee can't be read the call gets 503, so Bob retries (for three days). The run's
  idempotency key is `type:employeeId:triggeredAt`, so a redelivery starts no second run.
- **HiBob** (action): Employee → *Get* (by id or email; *When Not Found*: fail or output nothing) and *Search* (by
  email; *Include Inactive*). A 429 waits `Retry-After` (up to 10 s) and is tried twice more.

**The worker** is one shape whatever the HR system: `source`, `sourceId`, `email`, `givenName`, `familyName`,
`displayName`, `department`, `title`, `site`, `managerEmail`, `startDate`, `endDate`, `status`, and from the trigger
`event`, `changedFields`, `triggeredAt`, `triggeredBy`, `companyId`. It reads Bob's flat machine format
(`"/work/department": { "value": "…", "humanReadable": "R&D" }`, asked for with `humanReadable: "APPEND"`, so list
fields come as names) and the nested one.

### landbright (HTTP :7142, gRPC :7242)

- **Landbright API** credential: control's URL, the issuer, an application's client id and secret, and the scopes to
  ask for (default `directory:read directory:write`; Landbright grants only the scopes asked for). Tokens come from
  `{issuer}/token` with `resource=urn:landbright:api` and are kept until a minute before they expire.
- **Landbright** (action): Person → *Create or Update* (the input item as the worker, or fields; *Send Invite*), *Get*,
  *Deactivate* (`reason`); Group → *Add Member* (optionally until a time), *Remove Member*, *Get by Name*. Errors carry
  Landbright's message; *Continue on fail* as everywhere.

### The Joiner flow

`integrations/landflow/flows/joiner-hibob.json`: HiBob Trigger (`employee.created`, `employee.joined`) → Landbright:
Person → Create or Update. The birthright groups stay with the *Onboard* flow (on `identity.created`), so the map is in
one place. See [landflow-flows.md](landflow-flows.md#the-flows).

## Run it locally

```bash
pnpm fake-hibob            # a fake Bob on http://127.0.0.1:57994/v1, fictitious people
pnpm plugins:start         # both plugins, announcing to the throwaway Landflow (LANDFLOW_REGISTRY_URL)
cd e2e && LANDFLOW_OIDC_ENV_FILE=… node landflow/install.ts
```

The installer creates the *HiBob* and *Landbright (plugin)* credentials when both plugins are online (the HiBob values
default to the fake Bob: `HIBOB_BASE_URL`, `HIBOB_SERVICE_USER_ID`, `HIBOB_TOKEN`, `HIBOB_WEBHOOK_SECRET`), publishes
the Joiner flow and prints the URL to give Bob. The fake Bob sends signed events itself:

```bash
curl -X POST http://127.0.0.1:57994/_fake/deliver -H 'content-type: application/json' \
  -d '{"url":"http://localhost:57300/api/webhook/app/<workflow id>/trigger","type":"employee.created","employeeId":"3332883884017713238"}'
```

`POST /_fake/employees` adds or changes an employee (a start date of today, then `employee.joined`, is their first day).

## Tests

- `integrations/landflow/plugins/hris/test` (24): the worker in both shapes, the credential, the HiBob node (429 retries,
  continue on fail), the trigger (ping, signatures, event filter, fetch, 503 for Bob to retry, idempotency key).
- `integrations/landflow/plugins/landbright/test` (8): against a fake Landbright: the token (one per lifetime), upsert
  from an item or fields, get, deactivate, groups by name.
- `e2e/test/hr-joiner.test.ts` (7): the two plugins' nodes against the built stack: a signed delivery makes a pre-hire
  with no invite; a redelivery changes nothing; `employee.joined` activates with the invite; the worker activates a
  start date that came, audited by *Start dates*; linking by email; a deactivated person stays so; a forged delivery is
  refused.
- Screens 90 and 91.

## Live check (2026-11-14)

The throwaway Landflow (`deploy/landflow`) with both plugins announced and the fake Bob, nothing else changed:

- A signed `employee.created` for Noa Barak (fictitious; start date a week out) ran the Joiner flow: a pre-hire in
  Engineering with Maya as manager and *From HiBob*. The *Onboard* flow then put her in *Everyone*, *Engineers* and
  *Landflow Editors*, set her required actions, and emailed a welcome saying her invite comes on her start date. No
  invite, and nothing pushed to Landflow.
- A redelivery, Bob's ping (200) and a call with a forged signature (401) started nothing new.
- Her start date moved to today in Bob and Bob sent `employee.joined`: active, invite sent, and **one second later** SCIM
  had created her in Landflow and put her in *Landflow Editors*.
- She set her password from the invite and signed in to Landflow through Landbright (adding an authenticator and
  accepting the terms on the way), arriving as the Landflow user SCIM had made.

Bug found and fixed: the *Onboard* flow failed for a pre-hire (*Only active people can be asked to do something*);
required actions are now accepted for pre-hires, without the email.
