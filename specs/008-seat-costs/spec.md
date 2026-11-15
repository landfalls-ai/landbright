# Spec 008: Seat costs and the cost gate

Landledger's wave 3, *Tool or seat* ([landledger `docs/integrations.md`](../../../landledger/docs/integrations.md#tool-or-seat-spec-010)).
[Plan](plan.md) · [Tasks](tasks.md).

A paid seat is spend. Landbright owns access (the bundle, its policy, the grant); Landledger owns the cost (its
request, its policy, the decision, the seats on the contract); Landflow carries the conversation between them. Neither
decision leaves its system: Landbright's approvers decide access in Landbright, Landledger's approvers decide the cost in
Landledger. This spec gives Landbright the two things that conversation needs.

## First slice: a seat cost and a step a system settles

- **A seat cost on a bundle's target.** A target can say a grant of it costs a seat:
  `cost: { kind: "seat", landbrightApp: "linear" }`. `landbrightApp` is the key Landledger's contract names. Landbright
  holds no price. The request shows the costs of its bundle (`costs`), and `request.created` carries the
  `landbrightApp`s, so a flow knows without another call.
- **An external step.** A policy step can be `kind: "external"`: settled by a system, not by people voting. It names
  the application that settles it (`settledBy`, a client id), what the system is called (`system`, *Landledger*), and
  how long it may wait (`deadlineMinutes`). It is a gate only:
  - It is the first step, there is at most one, and the policy keeps at least one people step after it. A system can
    deny a request or let it through to the people; it never approves access (principle IV).
  - That application settles it on the machine API with a new scope, `steps:settle`:
    `POST /api/v1/requests/:id/steps/:step/settle { outcome, reference: { system, id, url? }, reason? }`. Approve opens
    the next step; deny ends the request. The same call again answers 200; a different one, 409. Audited
    `request.step_settled` with the reference.
  - While it waits, the request's deadline is the step's; once it is settled, the people get the policy's whole
    decision time from then. A step that runs out expires the request.
  - Nobody votes on it, and the decision page says *Waiting on Landledger* with the reference once settled, never as a
    person's vote. Escalation never adds people to it, and counts its time from when the people's step started.
  - **Auto-approval** waits for it: a request a rule would approve is approved by that rule once the step is settled.
  - **Break-glass** skips it: the grant is made at once, as today; the flow raises the cost afterwards (Landledger's
    `origin.breakGlass`). Settling a break-glass request answers 409 saying it was skipped.
  - **An extension** has the step too. The flow decides whether it rides on the first cost request (and settles at once,
    citing it) or needs a new one (it crosses the contract's renewal date, or changes the seat count): that is
    Landledger's fact, not Landbright's.
- **A new step starts → `request.step_started`.** When a request moves to its next step (enough approvals, or the gate
  settled), Landbright says so, and the approval flows (email, Slack) start on it as on `request.created`, so the next
  step's approvers are asked. This also closes a gap for any multi-step policy: until now only the first step's
  approvers were asked by a flow.
- **Console:** the bundle editor adds a *cost gate* (application, name, deadline); a target's JSON takes `cost`; the
  request page shows the gate's state and reference; the catalog shows a seat cost.

## Second slice (later): seats used

`GET /api/v1/seats?landbrightApp=` (`requests:read`): grants live now for bundles whose targets carry that app, and
people holding it through a standing (SCIM) group, counted apart, each with its `asOf`. Landledger sums them. It waits
on a way to say which provisioning target is which `landbrightApp`, and on Landledger asking for it.

## Out of scope

The Landledger flow itself (the Click house session builds it in Landflow, from `request.created` to the settle route);
a price or a budget in Landbright; external steps that are not first; more than one system per request.
