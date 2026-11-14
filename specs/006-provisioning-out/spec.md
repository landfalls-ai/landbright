# Spec 006: Provisioning out

Status: building (2026-11-14). [Plan](plan.md) · [Tasks](tasks.md). Wave 2 of [plan.md §9](../../docs/plan.md#9-waves).

Today revocation stops at Landbright ([limitations.md](../../docs/limitations.md)): deactivating a person ends their
Landbright sessions and tokens, but every application that signed them in keeps its own session. And an application
learns who exists only when they first sign in. Wave 2 makes Landbright the SCIM 2.0 client that Okta or Entra would
otherwise be, for Landflow, Landfall and Clickland, so each application holds the people and groups Landbright says,
and a change in Landbright reaches it within seconds.

## First slice (the wave's proof)

**Deactivating a person in Landbright signs them out of Landflow within seconds**, with no change to Landflow:
Landbright pushes `active: false` to Landflow's SCIM server, which deletes their sessions.

## What it does

- **Provisioning targets.** An administrator connects an application's SCIM server: its base URL, a bearer token
  (kept encrypted, never shown again) and the Landbright groups *assigned* to it. Optionally the OIDC application it
  belongs to. *Test* checks the URL and the token.
- **Who is pushed.** Every active person in an assigned group. A person who leaves every assigned group, or is
  deactivated, suspended or not yet started, is set `active: false` in the application, not deleted. Agents aren't
  pushed (wave 5).
- **Groups, two ways.** For servers that store groups (Landflow, Clickland), the assigned groups are pushed as SCIM
  Groups with their members; the application maps them (Landflow's `LANDFLOW_SCIM_GROUP_MAP` turns *Data Team* into
  editor on the *Data* project). For servers that take a person's groups on the person (Landfall: it chooses a role from
  them), Landbright sends each person's assigned groups as their `groups`. A group removed from the target, or deleted
  in Landbright, is deleted in the application.
- **Just-in-time access reaches the applications.** A grant adds a membership to a group; if that group is assigned
  to a target, the membership is pushed, and removed when the grant ends. This is what spec 004's Landflow flows did
  by hand for project roles, now with no flow.
- **Within seconds, retried until it lands.** Every change is in the audit log, which is the outbox: each target reads
  it from its own cursor, and the person or group changed is queued and pushed on the next pass (every 2 seconds). A
  push that fails is retried with back-off (5 s doubling to an hour) until it succeeds; the target shows what is
  failing and why.
- **Reconciliation.** Every 15 minutes, on any change to the target, and on *Sync now*, Landbright compares each
  person and group with what the application holds (where the server can say) and fixes the difference: someone
  reactivated by hand in the application is set inactive again.
- **Adopting existing accounts.** A person who already has an account in the application (for example, created at
  their first sign-in) is found by their email and linked, with Landbright's id as their `externalId`, not
  duplicated.
- **Ledger.** Every push that changes something is an audit event (`provisioning.*`), and so a Landflow flow can
  subscribe to it, for example to `provisioning.push_failed`.

## Second slice

- **Landfall and Clickland live** (each as its server is ready: Landfall's is per organization and switched on by
  its admin; Clickland's is being built).
- **OpenID Back-Channel Logout 1.0** for applications that take it: when a person is deactivated or ends their
  sessions, Landbright posts a signed logout token to each application they had signed in to.
- **The grant's timeline** shows each application a grant's group was pushed to and when it was removed.

## Out of scope

Pulling from SCIM (inbound SCIM: Landbright as a SCIM server), SCIM `/Bulk`, pushing agents, attribute mappings
beyond name and email, per-target renaming of groups (the application maps names itself), and Landledger (its
SCIM server is planned; it becomes a target when it exists).
