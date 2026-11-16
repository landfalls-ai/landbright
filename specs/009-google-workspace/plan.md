# Plan 009

[Spec](spec.md) · [Tasks](tasks.md) · [Research](research.md).

## Where it lives

A third plugin next to `hris` and `landbright`: `integrations/landflow/plugins/google-directory` (plugin id
`gdirectory`, HTTP :7143, gRPC :7243), TypeScript on `@landflow/sdk`, for the reasons plan 007 gave: a plugin is its
own process, it speaks Landbright's world, and Landbright's rules say Landflow changes only when asked. Landflow's own
Google Workspace plugin (Go, `plugins/google-workspace`) covers Sheets, Gmail, Drive, Calendar and Docs, not the
directory; this one doesn't touch it, and could move into it later.

## The plugin

### Credential `googleDirectoryApi`

| Field | |
|---|---|
| `serviceAccountEmail` | `client_email` of the key |
| `privateKey` (password) | `private_key`; literal `\n`, one line, or the whole JSON key file all work (as Landflow's Google plugin) |
| `adminEmail` | The administrator the service account acts as (`sub`). Empty: the service account's own admin role |
| `customer` | Default `my_customer` |
| `baseUrl` | Default `https://admin.googleapis.com`; the fake Google locally |
| `tokenUrl` | Default `https://oauth2.googleapis.com/token` |

Tokens: an RS256 JWT signed with `jose` (`iss`, `scope` = the three directory scopes, `aud` = the token URL, `iat`,
`exp` = an hour, `sub` when set), exchanged with the JWT bearer grant; cached in memory per (email, sub, token URL)
until a minute before expiry. `unauthorized_client` becomes a message that names the Admin console page and the three
scopes. Test: a token, then `GET /admin/directory/v1/users?customer=…&maxResults=1`.

Retries: 429, 503, and 403 with reason `userRateLimitExceeded`, `rateLimitExceeded` or `quotaExceeded` wait
2^n s + jitter (n = 0, 1, 2) and try again, three times at most; anything else fails the item with Google's status,
reason and message, and a hint for 401/403/404.

### Node `gdirectory.googleDirectory`

| Resource → operation | Parameters | Does |
|---|---|---|
| User → Create or Update | Email, Given Name, Family Name, External ID (Landbright's person id), Department, Title, Manager Email, Org Unit Path (create only), Unsuspend | Finds by `externalId=<id>` (when given), else `GET /users/<email>`. Found: `PATCH` only what differs (names, `organizations`, `relations`, the email when the external id found someone with another address, `externalIds` when linking, `suspended: false` when Unsuspend); else `POST /users` with a 32-character random password and `changePasswordAtNextLogin: false` (nobody learns it: they sign in through Landbright, or an administrator resets it). A 409 on create (a run beside this one created them) is read again and updated. Outputs `{ user, created, linked, changed[] }` |
| User → Get | Email or External ID; When Not Found (fail / nothing) | The user |
| User → Suspend | Email; Sign Out (default on) | `PATCH { suspended: true }`, then `POST /users/<email>/signOut`. Already suspended: unchanged. Not found: nothing (they never had an account) |
| User → Unsuspend | Email | `PATCH { suspended: false }` |
| User → Sign Out | Email | `POST /users/<email>/signOut` |
| User → Set Groups | Email, Wanted Groups, Managed Groups | `GET /groups?userKey=<email>`; adds the wanted ones missing (409 counts as done; a 404 on the user is retried, as a new account may not have propagated); removes managed groups not wanted (404 counts as done); groups outside the managed list are left alone. Outputs `{ email, added[], removed[], kept[] }` |
| Group → Add Member / Remove Member | Group email, member email, role (member) | Idempotent the same way |

No operation makes an administrator, deletes a user or creates a group.

### The fake Google (`test/fake-google.ts`)

One server for the tests and the live check: the token URL (checks the JWT's signature against the seed service
account's public key, `aud`, `exp`, the scopes, and `sub` among its administrators; else `unauthorized_client`), users
(insert, get by email or id, patch, list with `email=` and `externalId=` queries, sign out), groups by member, members
add and remove, all with Google's error shape; and `/_fake/state`, `/_fake/fail` (the next N calls answer 429) for the
tests. Its key pair is made at start and written (mode 600) where the live check's credential reads it. Fictitious
domain `landbright.test`, fictitious groups.

## The flow `google-people.json`

```
Landbright Trigger (identity.*, group.member_added, group.member_removed)
  → Who (code): the person's id (target for identity.*, data.identityId for group.*), the event
  → Landbright: Person → Get (When Not Found: nothing; an agent's id finds no person)
  → Plan (code): the map { Landbright group → Google group }, the domain; outputs
       { action: upsert | suspend | skip, email, names, department, title, managerEmail, wanted[], managed[], unsuspend }
  → Switch on action
       upsert  → Google Directory: User → Create or Update → User → Set Groups
       suspend → Google Directory: User → Suspend (sign out)
```

- `skip`: pre-hires (their account comes on their start date, `identity.activated`), anyone whose email isn't in the
  domain, and a deactivated person's group changes (deactivation removes memberships; the suspension already covers it).
- `unsuspend` is true on `identity.reactivated` only: an account suspended in Google for another reason isn't undone
  by an unrelated update.
- `__GOOGLE_DOMAIN__` is replaced by the installer (default `landbright.test`), as `__LANDBRIGHT_API__` is.
- The installer (`e2e/landflow/install.ts`) adds the flow and a `googleDirectoryApi` credential pointed at the fake
  Google; `pnpm plugins:start` starts the third plugin.

## Second slice: OIDC sign-in for Google

- Migration `client_pkce`: `oidc_client.pkce_required boolean not null default true`.
- Contracts: `pkceRequired` on the application view, create and update. The API creates only clients with a secret
  (`client_secret_basic` or `client_secret_post`); false is refused (409) for an agent's application (`private_key_jwt`),
  and the console's own client can't be edited (403). Audited in `client.created` / `client.updated` (`pkceRequired`
  among the changed fields). The identity plane checks again: it lets PKCE go only for a client that isn't an agent's
  and doesn't authenticate with `none`.
- The identity plane passes it to `oidc-provider` as client metadata (`pkce_required`, through `extraClientMetadata`)
  and `pkce.required` reads it; `LANDBRIGHT_PKCE_OPTIONAL_CLIENTS` keeps working for the conformance run.
- The console's application page: *Require PKCE* (on), with the reason it may be off, shown only for a client with a
  secret.
- `email` is already in the ID token when the `email` scope is granted (`conformIdTokenClaims: false`); the e2e checks
  it, as that is what Google matches on.

## Design review

Checked against the sources on 2026-11-16.

| Claim | Checked against | Result |
|---|---|---|
| A plugin can live outside Landflow's tree | `landflow/docs/protocol.md` §1; the `hris` and `landbright` plugins | Holds |
| Credentials are sent decrypted per call; plugins cache nothing the host renews | `landflow/docs/protocol.md` §7 | Holds: the plugin caches only its own Google token, keyed by the credential's fields |
| Landflow's Google plugin has no directory nodes | `landflow/plugins/google-workspace/README.md` (Sheets, Gmail, Drive, Calendar, Docs; scopes without `admin.directory.*`) | Holds |
| `identity.activated`, `identity.reactivated`, `identity.deactivated`, `group.member_*` carry the person | `apps/control/src/directory/people.service.ts`, `groups.service.ts`, `access/grants.ts` | Holds: `targetId` for identity events, `data.identityId` for group events (birthright and grants included) |
| `GET /api/v1/people/:id` gives the manager's email and the groups | `libs/contracts/src/directory.ts` `Person` | Holds (`manager.email`, `groups[].name`) |
| Google requires a password on create | Directory API `User.password` | Holds: a random one, never stored or shown |
| `GET /groups?userKey=` lists a user's direct groups | Directory API groups.list | Holds; nested groups aren't followed, and don't need to be (the flow manages direct memberships) |
| Google matches SSO on the `email` claim | Google's *Setting up SSO* | Holds; Landbright's ID token carries `email` with the `email` scope (`conformIdTokenClaims: false` in `apps/idp/src/oidc/provider.ts`) |
| PKCE can't be assumed from Google | Google documents no PKCE for OIDC profiles; Landbright requires PKCE for every client (`provider.ts`, `pkce.required`) | Hence the per-application setting, confidential clients only |
| Landbright's deactivation ends Google sessions | It doesn't: Google keeps its own | Hence Suspend signs out too |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt plumbing | PASS | Google's documented REST API and OAuth 2.0 JWT bearer grant; OIDC for sign-in, no SAML of our own |
| II. Default deny | PASS | The plugin asks only the three directory scopes; never grants admin, never deletes; PKCE stays required unless an administrator turns it off for one confidential client |
| III. Accountable human | PASS | Agents are skipped: they get no Google account |
| IV. Policy or a person approves | PASS | Google memberships follow Landbright's groups (birthright by the HR map, grants by approved requests); nothing is decided in Google or in the flow |
| V. Ledger | PASS | Landbright's events start every change; Landflow's executions record each Google call; `client.updated` records a PKCE change |
| VI. Standards | PASS | OIDC authorization code; the Directory API as documented |
| VII. N-up safe | PASS | Every operation is idempotent (409 and 404 counted as done), so concurrent runs for one person converge; the token cache is per process and only an optimization |
| VIII. Spec-driven | PASS | Plugin unit tests against the fake Google, e2e for PKCE and the ID token, a live check through the real flow |
| IX. Local only | PASS | A fake Google on 127.0.0.1, fictitious people and domain; no Google tenant, no real key |
