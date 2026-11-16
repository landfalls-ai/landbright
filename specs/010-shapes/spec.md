# Spec 010: Shapes

Asked by the user on 2026-11-16: Landbright connected to Shapes HR, so that "when a human is created in the Shapes HR"
they are created in Landbright and, through [spec 009](../009-google-workspace/spec.md), in Google. The Shapes API key
comes "only later on": for now, research Shapes' API, and build it as "a plugin that calls LandFlow".
[Plan](plan.md) · [Tasks](tasks.md) · [Research](research.md).

Shapes (shapes.co, formerly DreamTeam) becomes the second HR system after HiBob. The `hris` plugin, already in this
repository, gets Shapes nodes that output the same **worker** the HiBob nodes do, so the Landbright side doesn't change:
Landbright's *Person → Create or Update* takes it, the start date makes a pre-hire, the termination date becomes the
last day, and the *Onboard* and *Google Workspace* flows follow.

## What a person sees

HR adds Yael to Shapes, starting today, in Engineering. Shapes' workflow (*Employee created*) sends its webhook to
Landflow; within seconds Yael is in Landbright with her birthright groups, gets her invite, and has a Google account in
the Engineering group. Dan starts next week: he is a pre-hire, with no Google account until his start date. When HR moves
Yael to Finance, her groups follow; when HR sets her termination date, Landbright deactivates her after her last day and
Google suspends her account. If Shapes' webhook is lost (Shapes tries once), the changes poll catches it within 15
minutes.

## The nodes (`hris` plugin)

- Credential **Shapes API**: the API URL (default `https://api.shapes.co/v1`), a system user's **refresh token** (from
  *My settings → API tokens*), and the **webhook secret** of the workflow's *Send webhook* action. *Test connection*
  spends the refresh token and reads `me`.
- **Shapes Trigger** (an app webhook): a delivery from a Shapes workflow's *Send webhook* action. Signed with the
  secret (`X-Webhook-Signature`, HMAC-SHA256) or refused; a body older than five minutes refused; with *Fetch Employee*
  (on), the employee is read and the item is the worker. Shapes' workflow id, its run and step make the idempotency key.
- **Shapes Changes Trigger** (a poll, every 15 minutes by default, no more often than every 5): the employees whose
  worker fields changed since the last poll, with five minutes of overlap. The first poll sets the baseline.
- **Shapes** (action): Employee → *Get* (id or email), *Search* (by email), *Get Changed* (since a time).

## The flows

- `people-from-shapes.json`, **People from Shapes**: Shapes Trigger → Landbright: Person → Create or Update.
- `changes-from-shapes.json`, **Changes from Shapes**: Shapes Changes Trigger → Landbright: Person → Create or Update.

## Out of scope

- A real Shapes account: there is none yet. Everything is checked against a fake Shapes that runs Shapes' published
  schema (the types the plugin uses) with graphql-js.
- Writing back to Shapes, custom fields, a full daily reconciliation, time zones from Shapes (it has none; Landbright's
  site zones apply).
- An immediate leaver: Shapes has no *terminated* trigger. A termination date arriving is the leaver path; a person who
  must lose access now is deactivated in the console (or by HiBob's flow, for HiBob).
