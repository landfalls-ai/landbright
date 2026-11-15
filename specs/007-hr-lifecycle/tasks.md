# Tasks 007

[Spec](spec.md) · [Plan](plan.md).

## Slice 1: a joiner from HiBob

- [x] T001 Migration `hr_sources` (`source_link`), contracts (`UpsertWorker`, `UpsertWorkerResult`, the person's
      `sources`), `identity.activated` and `identity.linked_to_source` as event types.
- [x] T002 `POST /api/v1/people`: create, link or update from a worker; pre-hire before the start date.
- [x] T003 Start dates: the sweeper activates pre-hires, with the invite.
- [x] T004 Console: the source and the start date on the person's page.
- [x] T005 The hris plugin: credential, HiBob Trigger, HiBob node, the worker, the fake Bob; its tests.
- [x] T006 The landbright plugin: credential, the Landbright node; its tests.
- [x] T007 e2e: the plugins' nodes against the built stack (a signed delivery → a pre-hire → active with an invite).
- [x] T008 The Joiner flow and the installer (credentials, the flow), and the plugins' start scripts.
- [x] T009 Live: the throwaway Landflow with both plugins, a delivery from the fake Bob, the person signing in to
      Landflow on their start date.
- [x] T010 Docs: `hr.md` (new), reference, limitations, roadmap, history, README, screens, landflow-flows.

## Slice 2: movers, leavers and the Landbright Trigger

- [x] T011 Movers and leavers: end dates deactivate in the worker; `GET /api/v1/people/by-source/…`; `PUT
      /api/v1/people/:id/birthright-groups`; the node's find-by-HR-record and *Set Birthright Groups*; flows
      `joiner-hibob` (+ updated), `leaver-hibob`, `onboard-new-person` (movers).
- [x] T012 Landbright Trigger (subscription on publish, JWT checked against the JWKS); `leaver-handover` flow.
- [x] T013 Start and end dates in the site's time zone (tenant settings, console card).
- [x] T014 Tests (plugin units, control units, e2e `hr-movers-leavers`), screens, docs, live check.
