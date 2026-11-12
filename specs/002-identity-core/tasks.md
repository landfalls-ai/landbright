# Tasks 002: Identity core and sign-in

First slice done on 2026-11-12.

- [x] T001 `libs/persistence`: schema, the init migration (role, grants, forced row-level security, audit trigger), the
      `NULLIF` policy fix, `withTenant`, audit chain, passwords, bootstrap, `db:setup`; unit and database tests.
- [x] T002 `libs/platform`: config, `crypto.ts`, `createValkey`, `applyServiceDefaults`; tests.
- [x] T003 `libs/contracts`: directory, applications, audit, session schemas.
- [x] T004 `apps/idp`: provider, adapter, keys, account claims, sign-in, invite and sign-out pages, lockout; page tests.
- [x] T005 `apps/control`: console sign-in and session, People, Agents, Groups, Applications, Audit, invite mail,
      health behind a session, cross-origin write check; route tests.
- [x] T006 `apps/console`: sign-in gate, user menu, People and person, Agents, Groups and group, Applications (secret
      once, Landflow settings), Audit log, Home counts; tests.
- [x] T007 `e2e`: console sign-in, invite from Mailpit, Landflow-shaped sign-in with the mapped role, refusals,
      deactivation revoking tokens, guards, audit chain, sign-out.
- [x] T008 Live check on the local stack in the browser (sign-in, group, person, invite, password, application,
      Landflow-shaped sign-in, audit, sign-out). Bug fixed: "1 groups".
- [x] T009 Docs: this spec, `docs/sign-in.md`, `docs/directory.md`, reference, limitations, roadmap, history.
- [x] T010a TOTP at sign-in: the second-step pages (code, setup with QR, *Not now* for 30 days), single use per step,
      sealed keys, `amr` in the ID token, the administrator reset; unit, console and end-to-end tests. Live check;
      fixed: the stylesheet was cached across a change (now content-hashed), `amr` missing from the ID token, the setup
      key wrapping under its label, the services hanging on restart while a browser held a connection.
- [ ] T010b Passkeys (the identity plane moves to `localhost`: WebAuthn refuses IP addresses).
- [x] T011a Settings: tenant, *Require a second step*, sign-in methods, signing keys (read only).
- [ ] T011b Signing-key rotation (two published keys).
- [ ] T012 Playwright for the console and sign-in pages; the OpenID conformance suite in Docker.
- [ ] T013 A live sign-in to a running Landflow (needs Landflow's `.env`; ask first).
