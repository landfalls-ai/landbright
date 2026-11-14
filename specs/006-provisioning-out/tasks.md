# Tasks 006

[Spec](spec.md) · [Plan](plan.md).

## Slice 1: the SCIM client, and Landflow

- [x] T001 Migration and schema: `scim_target`, `scim_link`, `scim_job`, under row-level security.
- [x] T002 Contracts: `ScimTarget`, `CreateScimTarget`, `UpdateScimTarget`, `ScimTargetDetail`; the audit actions.
- [x] T003 The SCIM client (`apps/control/src/provisioning/scim-client.ts`) and the operations (users, groups, both
      modes), with unit tests.
- [x] T004 `ScimSync`: match, reconcile, push, back-off; run from the event worker.
- [x] T005 API: targets, token, sync, test.
- [x] T006 Console: Provisioning list, add, a target's page.
- [x] T007 e2e `provisioning.test.ts` against a Landflow-like and a Landfall-like fake server: create, adopt,
      deactivate, reactivate, leave scope, groups and members, a just-in-time grant, rename, unassign, retry after
      failure, reconcile drift.
- [x] T008 Live: the throwaway Landflow with `LANDFLOW_SCIM_GROUP_MAP`; a person signed in to Landflow is deactivated
      in Landbright and signed out within seconds; a grant of *Data Team* makes them editor on *Data* and its end
      removes it. Browser screenshots.
- [x] T009 Docs: `provisioning.md`, reference, limitations, roadmap, history, README, screens.

## Slice 2: Landfall, Clickland, back-channel logout

- [x] T010 Landfall live (user-attribute mode), once its SCIM is on. ✓ 2026-11-14
- [x] T011 Clickland live, once its server answers. ✓ 2026-11-14
- [ ] T012 Back-channel logout: an application's `backchannel_logout_uri`; logout tokens on deactivation and on
      ending sessions.
- [ ] T013 The grant's timeline shows pushes to applications.
