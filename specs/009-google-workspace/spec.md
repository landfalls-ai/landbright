# Spec 009: Google Workspace

Asked by the user on 2026-11-16: connect Landbright to Google Workspace so that a person HR creates gets a Google
account, "even if it's in the form of a plugin", with the flows in Landflow. [Plan](plan.md) · [Tasks](tasks.md) ·
[Research](research.md).

Landbright decides who works here; Google Workspace follows. A Landflow plugin in this repository (**Google
Directory**) speaks Google's Admin SDK Directory API, and a Landflow flow on the Landbright Trigger keeps every person in
step. Then Google sends its sign-in to Landbright (a custom OIDC SSO profile), so a person has one password and
Landbright's sign-in rules, and a leaver loses Google with everything else.

## First slice: accounts and groups

A fictitious joiner from HiBob starts on Monday. On their start date Landbright makes them active; the flow creates
their Google account (name, department, title, manager, Landbright's id as an external id) and puts them in the Google
groups their Landbright groups map to. When HR moves them to another department, the Onboard flow moves their birthright
groups and the Google groups follow; a time-limited grant of a mapped group adds them to its Google group and its expiry
removes them. When they leave, Landbright deactivates them and the flow suspends their Google account and signs them out
of Google everywhere.

### The plugin (`gdirectory`)

- Credential **Google Directory (service account)**: the service account's email and private key (the whole JSON key
  file works too), the administrator to act as (domain-wide delegation; empty when the service account has an admin role
  of its own), the customer (`my_customer`), and overridable API and token URLs (for the fake Google). Test: a token,
  then a one-user list.
- Node **Google Directory**:
  - User → **Create or Update** (by Landbright's id, kept in the user's external ids, else by email: linked; else
    created with a random password nobody learns), **Get**, **Suspend** (and sign out), **Unsuspend**, **Sign Out**,
    **Set Groups** (the user's memberships among a managed list become exactly the wanted ones).
  - Group → **Add Member**, **Remove Member**.
- Never makes anyone an administrator and never deletes a user (suspension keeps their mail and files for whoever takes
  over).

### The flow (*Google Workspace: keep people in step*)

On `identity.*` and `group.member_*`: read the person; skip anyone outside the Google domain, agents and pre-hires.
Active: create or update, and set their groups from the map (Landbright group → Google group, edited in the flow like
the birthright map). Reactivated: also unsuspend. Deactivated: suspend and sign out. One flow for every event, so a
burst of events for one person converges on the same state.

## Second slice: signing in to Google through Landbright

- An application can be marked as not requiring PKCE, only when it authenticates with a secret (Google doesn't say it
  sends PKCE). Everything else keeps PKCE required.
- [docs/google-workspace.md](../../docs/google-workspace.md) walks through both halves: the service account and its
  delegation, the flow's map, and the SSO profile (Landbright's issuer, the application's client id and secret, Google's
  redirect URI, assigning the profile to an org unit or group).
- The e2e plays Google's part: the authorization code flow with a client secret and no PKCE, an ID token whose `email`
  is the person's, and a deactivated person refused.

## Out of scope

- Google's inbound SCIM (GA July 2026): it needs a Google Cloud organization and its attribute mapping is undocumented;
  the Directory API is documented and does more (suspend, sign out, groups). Kept as an option in the research.
- SAML: not needed now that Google takes any OIDC provider; it stays the answer for editions without OIDC profiles
  (Essentials Starter) and for super administrators, whom SSO profiles never accept.
- Creating Google groups, org units by department, deleting or transferring a leaver's data, aliases, licences.
- A live Google tenant: there is none here. Everything is checked against a fake Google that answers as the docs say.
