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
- [x] T010b Passkeys: the issuer moves to `localhost`; sign in with a passkey alone, as the second step, or added when
      offered one; `amr` per RFC 8176 with `mfa`; the person page and Settings; a software authenticator in the e2e.
      Live check with the software authenticator against the running stack, and the pages in Chrome.
- [x] T011a Settings: tenant, *Require a second step*, sign-in methods, signing keys (read only).
- [x] T011b Signing-key rotation (two published keys): Settings → *Rotate*; the identity plane rebuilds its provider
      when the published set changes (checked at most every five seconds); a rotation waits until the replaced key's
      ID tokens have expired; unit tests for the rule, end to end (two rotations, old tokens still verify), live check.
- [x] T012a Playwright for the console and sign-in pages (`e2e/browser/`): the administrator builds the directory
      in the console, people set passwords from the invite, add a passkey (Chrome's virtual authenticator) or an
      authenticator app and sign in to a Landflow-shaped app; every screen captured to `docs/screenshots/`.
- [x] T012b The OpenID conformance suite in Docker (`pnpm conformance`): the OIDC basic plan, 35 modules, 21 passed,
      5 warnings, 4 skipped, 4 for review, 1 failed (POST to the authorization endpoint, left off). It found the
      `prompt=consent` loop, fixed (plan.md, *Conformance suite*).
- [x] T013 A live sign-in to the real Landflow: its own image as a throwaway instance (`deploy/landflow/compose.yml`,
      so the Landflow in use isn't touched), registered in the development Landbright; an admin and a member by group,
      and a deactivated person refused ([suite.md](../../docs/suite.md#try-it-landflow-signs-in-through-landbright)).
