# Feature 003: Access requests, the Landbright Trigger, and approval flows in Landflow

**Status**: proposed 2026-11-12; its first slice was built by [spec 004](../004-access-and-events/spec.md) on 2026-11-14, with changes (no Landflow change: JWT deliveries checked against Landbright's JWKS instead of a Landbright Trigger with Standard Webhooks; the audit log as the outbox) · **Plan**: [plan.md](plan.md)

## Why

Just-in-time access is the reason Landbright and Landflow belong together ([plan §4.2](../../docs/plan.md#42-just-in-time-access-the-apono-style-flow)):
Landbright decides and remembers, Landflow acts. A request for access has to reach Landflow as a trigger event, so a
flow the customer edits on the canvas can ask the right people, hear their answer, provision, and later revoke. The
decision itself has to stay in Landbright, because the constitution says only a policy or a person the policy names
may approve (principle IV), and the ledger of who approved what is Landbright's (principle V).

This is how the products we borrow from split the work too: Okta Identity Governance runs an approval sequence
whose steps can call a delegated Okta Workflows flow; ConductorOne and Entitle let a request policy call a webhook that
answers *approve* or *deny*; Apono sends request webhooks to Okta Workflows or Torq and accepts a webhook as a custom
approver. In each, the identity product owns the request and its decision; the workflow engine runs the conversation.

## User stories

1. **As a person**, I ask for *Landflow Editors* for 2 hours with a reason, in Landbright's portal (later in Slack, or
   from an agent's tool call). I see the request, who has to decide, and by when.
2. **As a flow author in Landflow**, I drop a **Landbright Trigger** on the canvas, pick *Request created* (optionally
   only for some bundles), publish, and every new request starts a run with the request, the requester and the
   approvers the policy named. I don't paste URLs or secrets: publishing registers the subscription at Landbright.
3. **As a flow author**, I build the approval conversation from nodes I already have: a Slack or email message to each
   approver with a link to decide, a Wait for the answer with the policy's deadline, then a branch on *approved*,
   *denied* or *expired*. A template does this for me.
4. **As an approver**, I follow the link, sign in with Landbright (a passkey if I have one), see the request and
   approve or deny it with a comment. My decision counts only if the policy names me and I'm not the requester.
5. **As the flow**, once a request is approved I provision the access, tell Landbright *provisioned* for each target,
   and the grant becomes active. When Landbright says *expiring* I can offer an extension; when it says *expired* I
   revoke and tell Landbright *revoked*.
6. **As an administrator**, I see on each request a timeline: created, delivered to the Landflow flow (with a link to
   its run), decided by whom and through which channel, provisioned, expired, revoked. I see failed deliveries and can
   resend.
7. **As an auditor**, I can answer "who had *Landflow Editors* on 3 October at 14:00, and who approved it" from the
   ledger alone, whatever happened in Landflow.
8. **Later (phase 4)**, as an approver, I click **Approve** on a Slack message without leaving Slack, for bundles whose
   policy accepts a decision made in chat.

## The events

Sent as Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>`), body
`{ "type", "timestamp", "data" }`. `data` is a snapshot of the request or grant, so a flow rarely needs another call,
and a link to re-read it, because deliveries can arrive late, twice or out of order.

| Event | When | Typical flow |
|---|---|---|
| `request.created` | A request needs a decision (not when a policy auto-approves it) | Ask the approvers |
| `request.decided` | Approved, denied, expired (deadline passed), or cancelled by the requester | Tell the requester; close the conversation |
| `grant.activated` | An approved grant starts (now, or at its scheduled start) | Provision each target |
| `grant.expiring` | 15 minutes before `expiresAt` (per policy) | Offer an extension |
| `grant.expired` | At `expiresAt` | Revoke each target |
| `grant.revoked` | Revoked early by an administrator, the requester, or a leaver | Revoke each target |

## Acceptance (first slice)

- An administrator defines a bundle (*Landflow Editors*, a Landbright group), a policy (eligible: *All staff*;
  approver: *Landflow Admins*; max 4 h; decision deadline 30 min) in the console.
- A Landflow flow from the shipped template, with a Landbright Trigger on `request.created`, published once; Landbright
  lists its subscription and the secret was exchanged only between the two services.
- Tal requests the bundle for 2 h. Within seconds the flow runs; the approver gets an email (Mailpit) from Landflow with
  a Landbright decision link; they approve after signing in; the flow's Wait resumes, the flow re-reads the request,
  and the grant is active: Tal is in *Landflow Editors* and Landflow shows them as a member at their next sign-in.
- At expiry the membership is removed by Landbright's sweeper whether or not Landflow answers, `grant.expired` reaches
  Landflow, and the revoke flow records *revoked*.
- Refused, each with an audit event: a decision by the requester; by someone the policy doesn't name; by an agent; after
  the deadline; a forged resume call to Landflow (the flow re-reads and sees no decision); a delivery with a bad
  signature or an old timestamp; *provisioned* for a request that isn't approved.
- With Landflow stopped, deliveries queue and are retried with back-off; the console shows them pending; nothing is
  lost or sent for a change that rolled back.
