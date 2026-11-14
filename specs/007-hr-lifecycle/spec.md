# Spec 007: Landflow plugins and the HR lifecycle

Wave 3 ([plan §3.3, §3.4, §4.1, §9](../../docs/plan.md#9-waves)). [Plan](plan.md) · [Tasks](tasks.md).

Landflow receives HR events and runs the joiner, mover and leaver flows; Landbright holds the identities they create.
Two Landflow plugins make that possible without code in Landflow itself: **hris** (HiBob's trigger and actions, one
normalized worker record) and **landbright** (Landbright's people and groups as nodes).

## First slice (the wave's proof)

A signed HiBob `employee.created` delivery for someone starting next week reaches Landflow's *Joiner* flow, which
creates them in Landbright as a **pre-hire** with their department, title, manager and start date. Their birthright
groups follow (the *Onboard* flow). They can't sign in yet. On their start date Landbright makes them active and
emails their invite; they set a password and sign in to Landflow, where SCIM has already put them with the role their
groups map to.

## What it does

### In Landbright

- **People from HR.** `POST /api/v1/people` (`directory:write`) creates or updates a person from an HR record, keyed by
  the record's source and id (`hibob` + employee id): the same record twice updates, never duplicates; a person already
  in Landbright with that email is linked, not duplicated. A start date in the future makes them `pre_hire`; today or
  past, `active`. The manager is found by email.
- **Start dates.** Every pre-hire whose start date has come (in UTC) becomes active, and gets the invite email if they
  have no password: `identity.activated`. Before that they can't sign in, aren't pushed over SCIM (only active people
  are), and get no invite.
- **The source link** is shown on the person's page (*From HiBob, employee 3332…*), and the console shows pre-hires
  with their start date.

### In Landflow (two remote plugins, in this repository)

- **hris**: credential **HiBob API** (base URL, service user id and token, the webhook's signing secret);
  **HiBob Trigger** (an app webhook set up by hand, as Bob has no subscription API: publishing checks the credential
  and the Publish menu shows the URL to paste into Bob) that verifies `Bob-Signature`, answers Bob's ping, filters
  event types, fetches the employee (on by default: Bob's payload is only an id) and outputs the **worker**; **HiBob**
  (action): Get and Search employees, also as workers.
- **landbright**: credential **Landbright API** (control's URL, the issuer, a client id and secret with machine API
  scopes; tested by getting a token); **Landbright** (action): Person → Create or update from a worker, Get, Deactivate;
  Group → Add member, Remove member, Get by name.
- **The worker record**, one shape whatever the HR system: `source`, `sourceId`, `email`, `givenName`, `familyName`,
  `displayName`, `department`, `title`, `site`, `managerEmail`, `startDate`, `endDate`, `status`, plus the event's
  `event` and `changedFields`.
- **The Joiner flow** (installed with the other flows): HiBob Trigger (`employee.created`, `employee.joined`) →
  Landbright: Person → Create or update. The Onboard flow, unchanged, adds the birthright groups on `identity.created`.

## Second slice

- **Mover** (`employee.updated` on department, title, manager or site: update the person, move birthright groups) and
  **leaver** (`employee.left` / `employee.inactivated` at the end of the last day; `employee.access.revoked.immediately`
  now: deactivate).
- **Landbright Trigger** in the landbright plugin: it registers its own subscription (`/api/v1/subscriptions`) when the
  workflow is published and verifies each delivery's JWT, so flows need no Webhook node with a JWT credential.
- Start dates in the site's time zone, not UTC.

## Out of scope

Shapes (blocked on its schema, plan §11), Workday and other HR systems, writing back to HiBob, and HR for agents.
