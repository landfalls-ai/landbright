# Tasks 004

| Task | What | Status |
|---|---|---|
| T001 | Study Keycloak 26.4.7 with Craft Anything; gap table and order of work ([research](research/keycloak-study.md)) | ✓ |
| T002 | Study the open-source JIT projects; adoption list ([research](research/jit-oss-study.md)) | ✓ |
| T003 | Contracts: `access.ts` (policy, bundle, request, grant, targets), `events.ts`, `machine-api.ts` | ✓ |
| T004 | Migration `access_and_events` with forced RLS; `lastSignInAt` written at sign-in | ✓ |
| T005 | Machine tokens: oidc-provider resource indicators for `urn:landbright:api`; `ServiceTokenMiddleware`; `Service(scope)` | ✓ |
| T006 | `AccessService`: bundles, preview, create (supersede, break-glass, auto-approve), decide, cancel, revoke, targets, annotations, waits | ✓ |
| T007 | Grants: memberships with reference counting; leaver closes grants and requests | ✓ |
| T008 | Sweeper: deadline, escalation, scheduled start, expiring notice, expiry, revoke overdue | ✓ |
| T009 | Events: subscriptions, deliveries, signed JWT delivery, retries, resend, wake | ✓ |
| T010 | Machine API `/api/v1` | ✓ |
| T011 | e2e `access.test.ts`: 12 tests with a hook server verifying the JWT against `/oidc/jwks` | ✓ |
| T012 | Landflow flows (approve by email, provision a project role, disable inactive people) and the installer | ✓ |
| T013 | Live check: the real Landflow emails the approver, waits, wakes, provisions Tal in Payments, removes Tal on revoke | ✓ 2026-11-14 |
| T014 | Console: Requests, the request page, Grants, Catalog, Events; non-administrators see Requests | ✓ |
| T015 | Browser story: Ido asks in the console, the administrator approves and revokes; screenshots 40–48 | ✓ |
| T016 | Docs: access.md, events.md, landflow-flows.md, reference, limitations, roadmap, history | ✓ |
| T017 | Required actions, execute-actions link, forgot password (Keycloak P1) | Next |
| T018 | *Onboard* flow (required actions and birthright groups) | Next |
| T019 | Slack approvals; a Landbright node in Landflow (spec 003 phases 3–4) | Later |
