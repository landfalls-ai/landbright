# Tasks 009

[Spec](spec.md) · [Plan](plan.md).

## Slice 1: accounts and groups

- [x] T001 The `gdirectory` plugin: credential (JWT bearer token, cache, test), the Directory client (retries, errors),
      the Google Directory node (users, groups).
- [x] T002 The fake Google, and the plugin's tests against it (tokens, create, link, update, suspend, set groups,
      retries, errors).
- [x] T003 The flow `google-people.json`; the installer (credential, `__GOOGLE_DOMAIN__`); `plugins:start` and
      `verify` run the third plugin.
- [x] T004 Live check: a joiner, a mover, a grant and its expiry, a leaver, through the dev Landbright, the throwaway
      Landflow and the fake Google.

## Slice 2: sign-in through Landbright

- [x] T005 `pkce_required` (migration, contracts, control, the identity plane, the console).
- [x] T006 e2e: Google's part (code flow with a secret and no PKCE, `email` in the ID token, a deactivated person
      refused; PKCE still required elsewhere); browser screen.
- [x] T007 Docs: `docs/google-workspace.md`, reference, limitations, roadmap, history, README.
