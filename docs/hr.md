# People from HR

Wave 3 ([spec 007](../specs/007-hr-lifecycle/spec.md), [plan](../specs/007-hr-lifecycle/plan.md)): joiners, movers
and leavers from HiBob.

- **Joiners.** HiBob says someone was hired; Landflow runs the *Joiners and movers* flow; Landbright creates them as a
  **pre-hire** with their department, title, site, manager and start date. They can't sign in, aren't pushed to
  applications and get no invite until their start date begins in their zone. Then they become active, the invite email
  goes, and SCIM puts them in Landflow (and the other targets) with the groups the *Onboard* flow gave them.
- **Movers.** A new department, title, manager or site in Bob updates the person; a new department moves their
  birthright groups (the *Onboard* flow's map), and SCIM follows.
- **Leavers.** Bob's `employee.left` (after the last day) or `employee.access.revoked.immediately` deactivates them at
  once through the *Leavers* flow. Independently, a person whose **last day** (`endDate`, from HR or the console) has
  ended in their zone is deactivated by Landbright itself. When agents they sponsored are suspended with them, their
  manager is emailed (*Hand over a leaver's agents*, on the **Landbright Trigger**).

```
HiBob ──signed event──▶ Landflow: HiBob Trigger (hris plugin) ──worker──▶ Landbright node (landbright plugin)
                                                                              │ POST /api/v1/people, or deactivate
                                                                              ▼
       Landflow: Onboard flow ◀── identity.created / .updated ── Landbright ── start date ──▶ active, invite, SCIM
       (birthright groups: PUT …/birthright-groups)                         └─ last day ended ──▶ deactivated, SCIM,
                                                                                                  logout tokens
       Landflow: Hand over a leaver's agents ◀── identity.deactivated (Landbright Trigger, signed SET)
```

## In Landbright

### `POST /api/v1/people` (`directory:write`)

Creates, links or updates a person from an HR record, keyed by the record's **source and id** (`hibob` and the
employee id). See [reference/api.md](reference/api.md#machine-api-apiv1) for the fields.

1. **Found by its source link:** updated (names, department, title, site, manager, dates; the email too, unless someone
   else has it: 409).
2. **Else someone with that email:** linked to the record, then updated (`identity.linked_to_source`). An agent or a
   service with that email is a 409.
3. **Else created:** `pre_hire` when `startDate` is after today in their zone, otherwise `active` with the invite (no
   invite when their `endDate` has already ended: HR told Landbright late, and the worker deactivates them).
4. **A deactivated person isn't brought back** (409): reactivating is a person's decision, in the console.
5. **A pre-hire whose start date has come** is activated at once (`identity.activated`), with the invite.

The answer is `{ person, created, linked, changed }` (201 when created, else 200); `changed` names the fields that
moved, so a redelivery answers `changed: []` and records nothing but the time it was seen. The manager is found by email
among active people; an unknown one is left out. Every change is in the ledger with the application as actor and
`source` in the data.

### Start and last days, in the person's zone

HiBob documents no time zone for an employee or a site (it only says its lifecycle events fire at midnight in the
site's zone), so Landbright keeps them: **Settings → Start and last days** ([screen 92](screens.md)), or
`PATCH /api/settings/people`: a default zone (`UTC` unless set) and a zone per site, named as HR names the site. A
person's zone is their site's, else the default.

The event worker (every 2 seconds, one replica per tenant) activates pre-hires whose start date has begun in their zone:
status `active`, `identity.activated` (actor *Start dates*), and the invite email when they have no password and the
record didn't say `sendInvite: false`. `identity.*` events already queue SCIM pushes, so the applications hear of them
then, not before.

It also **deactivates people whose last day has ended** in their zone (actor *End dates*, reason *Their last day
(date) ended*): everything a console deactivation does (sessions, tokens, grants, sponsored agents suspended, SCIM and
logout tokens). That covers any HR system, and a contractor's last day set in the console ([screen 93](screens.md)). A
pre-hire whose last day passed (an offer withdrawn) is deactivated too. The last administrator isn't (logged once).

A pre-hire can be given required actions (the *Onboard* flow asks for a second step and the terms at the first sign-in),
but not emailed about them before they start (`notify` is a 409 for a pre-hire).

### Movers: birthright groups

`PUT /api/v1/people/:id/birthright-groups { groups: [names] }` (`directory:write`) makes the person's `hr` memberships
exactly those groups: adds the missing ones, removes `hr` memberships not listed, leaves memberships given by hand or by a
grant alone, and reports names with no group as `missing`. The administrators' group is refused. The *Onboard* flow calls
it for a joiner and again for a mover (`identity.updated` with `department` among the fields), so its map is the one
place birthright groups are decided.

### Leavers: found by their HR record

`GET /api/v1/people/by-source/hibob/<employee id>` (`directory:read`) answers the person an HR record is linked to. The
Landbright node's *Get*, *Deactivate* and *Set Birthright Groups* use it with *Find By: HR Record*, so a leaver event
that carries only Bob's employee id is enough.

### The console

The person's page shows the site, the start date, with *can sign in from then* for a pre-hire, the **last day** with
*access ends after it*, and **From**: *HiBob · employee
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

**Shapes** ([spec 010](../specs/010-shapes/spec.md), [below](#shapes)) adds the *Shapes API* credential, the *Shapes
Trigger*, the *Shapes Changes Trigger* and the *Shapes* action to this plugin.

**The worker** is one shape whatever the HR system: `source`, `sourceId`, `email`, `givenName`, `familyName`,
`displayName`, `department`, `title`, `site`, `managerEmail`, `startDate`, `endDate`, `status`, and from the trigger
`event`, `changedFields`, `triggeredAt`, `triggeredBy`, `companyId`. It reads Bob's flat machine format
(`"/work/department": { "value": "…", "humanReadable": "R&D" }`, asked for with `humanReadable: "APPEND"`, so list
fields come as names) and the nested one.

### landbright (HTTP :7142, gRPC :7242)

- **Landbright API** credential: control's URL, the issuer, an application's client id and secret, and the scopes to
  ask for (default `directory:read directory:write`; add `events:manage` for the Landbright Trigger; Landbright grants only the scopes asked for). Tokens come from
  `{issuer}/token` with `resource=urn:landbright:api` and are kept until a minute before they expire.
- **Landbright** (action): Person → *Create or Update* (the input item as the worker, or fields; *Send Invite*), *Get*,
  *Deactivate* (`reason`), *Set Birthright Groups* (names, one per line); the last three find the person by id or by the
  input worker's HR record (*When Not Found*: fail or output nothing). Group → *Add Member* (optionally until a time),
  *Remove Member*, *Get by Name*. Errors carry Landbright's message; *Continue on fail* as everywhere.

### The Landbright Trigger

An app webhook trigger on Landbright's events (*Events*: types or prefixes, default `identity.*`). Publishing the
workflow subscribes the node's URL through the machine API (`POST /api/v1/subscriptions`, `events:manage` in the
credential's scopes, and Landflow's origin among the application's redirect URIs); unpublishing deletes the
subscription; changing the events replaces it. Each delivery's `Authorization: Bearer` token must verify against
`{issuer}/jwks` (RS256, `typ: secevent+jwt`, the issuer, the audience it subscribed with, not expired), else 401; the
item is the **event inside the token**, not the body, and the run's idempotency key is the event id, so Landbright's
retries start one run. No secret is shared. It is what the *Webhook + JWT Auth credential* pair does for the core flows,
in one node.

### The HR flows

- `joiner-hibob.json`, **Joiners and movers from HiBob**: HiBob Trigger (`employee.created`, `employee.joined`,
  `employee.updated`) → Landbright: Person → Create or Update.
- `leaver-hibob.json`, **Leavers from HiBob**: HiBob Trigger (`employee.left`, `employee.access.revoked.immediately`;
  no read from Bob) → Landbright: Person → Deactivate, *Find By: HR Record*, *When Not Found: Output Nothing*, reason
  `HiBob: <event>`. Not `employee.inactivated`: Bob sends it for a leave of absence too.
- `leaver-handover.json`, **Hand over a leaver's agents**: Landbright Trigger (`identity.deactivated`) → if agents
  were suspended → Landbright: Person → Get → an email to their manager. An agent needs an accountable sponsor
  (principle III); it stays suspended until an administrator gives it one.
- The birthright groups stay with the *Onboard* flow, which now handles movers too. See
  [landflow-flows.md](landflow-flows.md#the-flows).

## Shapes

[Spec 010](../specs/010-shapes/spec.md) ([plan](../specs/010-shapes/plan.md), [research](../specs/010-shapes/research.md)).
Shapes (shapes.co, formerly DreamTeam) is the second HR system. Its nodes are in the hris plugin and output the same
worker, so everything after them is HiBob's path: pre-hires, start and last days, movers' birthright groups, and Google
([google-workspace.md](google-workspace.md)). There is no Shapes account here yet: the nodes are built from Shapes'
public schema and documents and checked against a fake Shapes that runs that schema.

- **Shapes API** credential: the API URL (default `https://api.shapes.co/v1`), a system user's **refresh token**
  (*My settings → API tokens*; a Super Admin, or an Admin covering every employee), and the **webhook secret** of the
  workflow's *Send webhook* action. Shapes' access token lasts 15 minutes and every refresh spends the refresh token
  for a new pair, so the plugin keeps the pair it gets back in a token store (`SHAPES_TOKEN_STORE`, default
  `~/.config/landbright/shapes-tokens.json`, mode 600, keyed by a hash of the pasted token, which it never stores).
  Give the token to this plugin only, and run one plugin process per store. A refused refresh says to create a new
  token and paste it.
- **Shapes Trigger** (an app webhook). Shapes has no event subscription: its **workflows** send webhooks. In Shapes, add
  a workflow triggered by *Employee created* and by *Employee field value changed* (start date, termination date,
  department, job, office, manager) with a *Send webhook* action to the URL the installer prints (or the Publish menu)
  and a secret. Every delivery needs a valid `X-Webhook-Signature` (HMAC-SHA256 of the body) and a `timestamp` within
  five minutes, else 401. With *Fetch Employee* (on), the employee is read and the item is the worker, with
  `event: shapes.workflow`, the workflow's name and `changedFields`; a read that fails answers 503 rather than run with
  half an employee. `X-Webhook-Id` makes the idempotency key.
- **Shapes Changes Trigger** (a poll, every 15 minutes by default, at least 5): the employees whose names, email,
  department, job, office, manager or dates changed since the last poll, with five minutes of overlap. Shapes tries a
  webhook once, so this is the safety net. The first poll sets the baseline; a manual run shows a few from the last week.
- **Shapes** (action): Employee → *Get* (Shapes id or email), *Search* (email), *Get Changed* (since a time).
- `TOO_MANY_REQUESTS` waits `retryAfterSeconds` (up to 30 s) and is tried twice more.

| Worker | Shapes |
|---|---|
| `sourceId`, `email`, `givenName`, `familyName`, `status` | the employee's `id`, `email`, `firstName`, `lastName`, `workStatus` |
| `department` | the *department* field, else *team* |
| `title`, `site` | *job*, *office* |
| `managerEmail` | *reports to* (the manager's email, read in a second call) |
| `startDate`, `endDate` | *start date*, *termination date* |

**A leaver from Shapes** is a termination date: Landbright deactivates them after their last day in their zone. Shapes
has no *terminated* trigger, so someone who must lose access at once is deactivated in the console.

**The flows**: `people-from-shapes.json`, **People from Shapes** (Shapes Trigger → Landbright: Person → Create or
Update), and `changes-from-shapes.json`, **Changes from Shapes** (Shapes Changes Trigger → the same). The installer
creates the *Shapes* credential when Shapes' API answers (`SHAPES_BASE_URL`, `SHAPES_REFRESH_TOKEN`,
`SHAPES_WEBHOOK_SECRET`; the fake Shapes' by default) and prints the webhook URL.

```bash
pnpm fake-shapes     # Shapes' API on http://127.0.0.1:57996/v1, fictitious people, the fake webhook secret
curl -X POST http://127.0.0.1:57996/_fake/employees -H 'content-type: application/json' \
  -d '{"id":"1003","firstName":"Yael","lastName":"Shamir","email":"yael.shamir@landbright.test","department":"Engineering","startDate":"2026-11-16"}'
curl -X POST http://127.0.0.1:57996/_fake/deliver -H 'content-type: application/json' \
  -d '{"url":"http://localhost:57300/api/webhook/app/<workflow id>/trigger","employeeId":"1003","contexts":["start_date"]}'
```

**Tests**: `integrations/landflow/plugins/hris/test/shapes.test.ts` (14): every query in the client validated against
Shapes' published schema; the refresh token spent once, the pair kept (mode 600, without the pasted token), renewed on
expiry, refused with the way out, one refresh for concurrent calls; the action (worker, manager by email, by email,
not found, changed since, rate limit); the trigger (publish needs the secret, a signed delivery, bad and stale
signatures, signature encodings, 503); the poll (baseline, changes, overlap).

**Live check (2026-11-16)**: a joiner, a pre-hire, a mover and a leaver from the fake Shapes through to the fake Google
([google-workspace.md](google-workspace.md#live-check-2026-11-16)).

**With the first real token**, check what Shapes hasn't published
([research.md](../specs/010-shapes/research.md#not-published-check-with-the-first-token)): how an expired access token
is answered, the signature's encoding, whether the system user can read *reports to*.

## Run it locally

```bash
pnpm fake-hibob            # a fake Bob on http://127.0.0.1:57994/v1, fictitious people
pnpm plugins:start         # both plugins, announcing to the throwaway Landflow (LANDFLOW_REGISTRY_URL)
cd e2e && LANDFLOW_OIDC_ENV_FILE=… node landflow/install.ts
```

The installer creates the *HiBob* and *Landbright (plugin)* credentials when both plugins are online (the HiBob values
default to the fake Bob: `HIBOB_BASE_URL`, `HIBOB_SERVICE_USER_ID`, `HIBOB_TOKEN`, `HIBOB_WEBHOOK_SECRET`), publishes
the three HR flows and prints the URLs to give Bob. The fake Bob sends signed events itself:

```bash
curl -X POST http://127.0.0.1:57994/_fake/deliver -H 'content-type: application/json' \
  -d '{"url":"http://localhost:57300/api/webhook/app/<workflow id>/trigger","type":"employee.created","employeeId":"3332883884017713238"}'
```

`POST /_fake/employees` adds or changes an employee (a start date of today, then `employee.joined`, is their first day;
a new `department`, then `employee.updated`, a mover; a `terminationDate`, a last day).

## Tests

- `integrations/landflow/plugins/hris/test` (24, HiBob; Shapes' 14 above): the worker in both shapes, the credential, the HiBob node (429 retries,
  continue on fail), the trigger (ping, signatures, event filter, fetch, 503 for Bob to retry, idempotency key).
- `integrations/landflow/plugins/landbright/test` (14): against a fake Landbright: the token (one per lifetime), upsert
  from an item or fields, get, deactivate, by HR record (not found: fail or nothing), birthright groups, groups by name;
  the Landbright Trigger: subscribe, check, replace and remove; a signed event starts a run keyed by its id; no token, a
  bad one, another key, another audience, another `typ` or an expired one is a 401; an event it didn't ask for is
  ignored.
- `apps/control/test/zones.test.ts` (4): dates in a zone, the site's or the default; the day-either-side bound the
  worker relies on; IANA zones only in the settings.
- `e2e/test/hr-joiner.test.ts` (7): the two plugins' nodes against the built stack: a signed delivery makes a pre-hire
  with no invite; a redelivery changes nothing; `employee.joined` activates with the invite; the worker activates a
  start date that came, audited by *Start dates*; linking by email; a deactivated person stays so; a forged delivery is
  refused.
- `e2e/test/hr-movers-leavers.test.ts` (6), against the built stack, with the zones furthest ahead of UTC
  (Kiritimati) and behind it (Pago Pago) so the hour doesn't matter: the settings (a bad zone is a 400); start dates in
  the site's zone, at the upsert and in the worker; a termination date from Bob deactivates when the day has ended there
  (*End dates*, no invite) and not before; a mover's birthright groups move and a membership by hand stays; a leaver
  found by their HiBob id; the Landbright Trigger subscribing, verifying a real delivery's token and unsubscribing.
- Screens 90–93; the console's zones card in `console.test.tsx`.

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

## Live check, second slice (2026-11-15)

The throwaway Landflow with both plugins (restarted with the new code) and the fake Bob; the installer republished the
flows (*Joiners and movers* in place of *Joiner*) and publishing *Hand over a leaver's agents* made its Landbright Trigger
subscribe itself (owner `landflow-local`, `identity.deactivated`). Zones: Tel Aviv → Asia/Jerusalem, London →
Europe/London; a *Finance* birthright group created for the Onboard map.

- **Mover:** Noa Barak (fictitious) moved from Engineering to Finance in Bob, `employee.updated`: Landbright updated her
  department and title, and the *Onboard* flow set her birthright groups (Engineers and Landflow Editors out, Finance in,
  Everyone kept) about two seconds later. Out of every group assigned to the Landflow target, SCIM deactivated her in
  Landflow two seconds after that.
- **Leaver:** with a fictitious agent she sponsored, Bob's `employee.left`: deactivated 60 ms after the delivery (*HiBob:
  employee.left*; four sessions and tokens revoked, the agent suspended), and the Landbright Trigger's signed delivery
  started *Hand over a leaver's agents*: Maya, her manager, had the email two seconds later.
- **Last day:** Gal Peretz (fictitious, London), whose termination date was yesterday there, arrived from Bob and was
  deactivated by *End dates* two seconds later.

Bug found and fixed: Gal got an invite email, though their last day had already ended; someone created after their last
day now gets none.
