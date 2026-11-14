# Feature 004: Just-in-time access and events out, with the flows in Landflow

**Status**: first slice built 2026-11-14 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) ·
**Research**: [Keycloak study](research/keycloak-study.md), [Craft Anything report](research/keycloak-craft-anything-report.md),
[open-source JIT study](research/jit-oss-study.md)

## Why

The user asked for two studies and an implementation:

1. Reverse-engineer Keycloak with [Craft Anything](https://github.com/storytold/craft-anything), and bring what it
   does well into Landbright.
2. Find the open-source just-in-time access projects, read how they work, and build the best of it.

They added one rule: *the actual flows should be Landflow flows*.

Both studies point the same way:

- **Keycloak.** Its workflows (experimental in 26.4: trigger, condition, delayed steps) are an engine inside the IdP,
  and they cover users only. Its event listeners run after commit, with no retry. An IdP that wants its processes run
  elsewhere needs the reverse: reliable events out, and actions in.
- **The JIT projects.** The strongest designs keep the decision in the identity product and let the workflow engine
  run the conversation (Teleport's plugins, Infisical's delegated approval). Thand puts the quorum inside an editable
  workflow, and shows what that costs.

So Landbright decides, records and emits, and Landflow flows do the rest. Spec 003 proposed the split; this spec builds
its first slice with what the studies added. It also replaces 003's Landflow-side parts (a Landbright Trigger node and
Standard Webhooks signatures) with what Landflow can do **today, unchanged**: a Webhook trigger whose JWT Auth checks
Landbright's signature against Landbright's JWKS.

## User stories

1. **As a person**, I ask for a bundle (groups, plus targets a flow provisions) for a while, with a reason. I see who
   decides, and the request page shows where it stands.
2. **As an approver**, a Landflow flow emails me (Slack later) a link to the request. I sign in to Landbright and
   approve or deny it. My vote counts only if the policy names me, through a standing membership, and I'm not the
   person asking or the person it's for.
3. **As the flow**, I start from Landbright's signed event, re-read the request over the machine API, attach a wait,
   sleep, and wake up when Landbright nudges me. I can never decide.
4. **As the provisioning flow**, when a grant activates I give each target I own (a Landflow project role) and report
   `provisioned` or `failed`. When it ends I remove it and report `revoked` or `revoke_failed`. A late
   `provisioned` after the end is refused.
5. **As Landbright**, at the grant's end I remove the group memberships I gave. I don't remove one that someone held
   before, or that another live grant still needs. I warn before the end (`grant.expiring`), and raise
   `grant.revoke_overdue` when a flow hasn't reported a removal in 15 minutes.
6. **As an administrator**, I deactivate a person (or a lifecycle flow does it through the machine API). Their grants
   end and their pending requests are cancelled, the same for the agents they sponsor.
7. **As a lifecycle flow**, every morning I find the people who haven't signed in for 90 days, warn their manager, wait
   a week, check again, and deactivate. This is Keycloak's *disable inactive users* workflow, run as a Landflow flow.
8. **As an administrator**, I see each subscription's deliveries (status, attempts, the flow's answer and execution id),
   and resend one.

## Requirements

- Every audit event is an event: subscriptions match on type or prefix (`grant.*`), get delivered at least once with
  retries for a day, and carry an `Idempotency-Key`. An event goes out only if its transaction committed.
- Deliveries are signed JWTs (Landbright's own signing key, `typ: secevent+jwt`, `aud` per subscription). No shared
  secret is stored anywhere.
- The decision is Landbright's: only signed-in people named by the policy vote; a service token never gets `decide`.
  One denial ends a request; approvals count per step, one per person; votes are re-checked against current
  eligibility.
- Approver fallback: when a step names nobody but the requester, the bundle owner and then the administrators decide.
  If still nobody, the request is refused when it's made.
- The duration is clamped at approval; agents get at most the policy's agent maximum.
- Break-glass (where the policy allows) and auto-approval rules approve at once, with their evidence kept on the
  request. Escalation adds people to the current step after a while.
- Machine API (`/api/v1`) for flows, under client-credentials tokens with scopes; flows can read, annotate (with
  compare-and-set), report targets, attach waits, and query and deactivate inactive people. Nothing else.
- The console: everyone can ask for access and decide the requests that name them. Administrators also see grants, the
  catalog (bundles with their policy), and event subscriptions with their deliveries.
- The three flows ship as Landflow workflow JSON built from Landflow's core nodes, with an installer.

## Out of scope (this slice)

Slack approvals; a native Landbright node or trigger in Landflow (spec 003 phases 3–4); extension requests;
access reviews; required actions, `acr` and the account page from the Keycloak study (next, see the plan's order of
work); SCIM.
