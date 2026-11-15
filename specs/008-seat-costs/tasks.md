# Tasks 008

[Spec](spec.md) · [Plan](plan.md).

## Slice 1: a seat cost and a step a system settles

- [x] T001 Contracts: `BundleTarget.cost`, `ApprovalStep.kind` and the external fields, `SettleStep`, the request view's
      steps, `waitingOnSystem` and `costs`; `steps:settle`; event types `request.step_settled`, `request.step_started`.
- [x] T002 The policy's rules when a bundle is saved (one external step, first, a people step after, `settledBy` a
      non-agent application).
- [x] T003 Requests: plan and file with a gate (its deadline, the kept auto rule); `settle` and
      `POST /api/v1/requests/:id/steps/:step/settle`; `request.step_started` on every next step; votes and tickets
      refused on the gate; the sweeper (escalation from the step's start, skipping the gate); wake-ups.
- [x] T004 Flows: the email and Slack approval flows start on `request.step_started`; the installer subscribes them
      and gives Landflow's application `steps:settle`.
- [x] T005 Console: the cost gate in the bundle editor, the seat in the catalog, the gate on the request page.
- [x] T006 Tests: e2e (`seat-costs.test.ts`: the policy's rules, the gate, auto, break-glass, extension, wrong callers,
      the gate's clock and escalation), browser screens 94–96; docs; live check.

## Slice 2 (later): seats used

- [ ] T007 `GET /api/v1/seats?landbrightApp=`: grants and standing members, apart, each with `asOf`.
