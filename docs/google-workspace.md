# Google Workspace

[Spec 009](../specs/009-google-workspace/spec.md) ([plan](../specs/009-google-workspace/plan.md),
[research](../specs/009-google-workspace/research.md)). Landbright decides who works here; Google Workspace follows.
Two halves, independent of each other:

1. **Accounts and groups.** A Landflow plugin in this repository, **Google Directory** (`gdirectory`), speaks Google's
   Admin SDK Directory API. The flow *Google Workspace · Keep people in step* runs on Landbright's events and creates,
   updates and suspends Google accounts and their group memberships.
2. **Signing in.** Google sends its sign-in to Landbright with a custom OIDC SSO profile, so a person has one password,
   Landbright's second step and sign-in rules, and a leaver loses Google with everything else.

```
HR (HiBob, Shapes) ──▶ Landflow HR flows ──▶ Landbright ── identity.*, group.member_* (signed) ──▶ Landflow:
                                              (people,       Google Workspace · Keep people in step
                                               groups,          read the person ─▶ plan ─▶ Google Directory node
                                               grants)                                       │ Directory API
                                                                                             ▼
                                   Google sign-in ── OIDC (code flow, client secret) ──▶ Google Workspace
```

## What happens to a person

| In Landbright | In Google |
|---|---|
| Created as a **pre-hire** (start date ahead) | Nothing yet |
| **Active** (created active, or their start date began) | An account: name, primary email, department and title (`organizations`), manager (`relations`), Landbright's id as an external id (`customType: landbright`), a random password nobody learns. Then their groups |
| **Updated** (name, department, title, manager, email) | Only the fields that differ are patched |
| **Group membership** added or removed (birthright from the *Onboard* flow, a grant, the console) | The mapped Google group gains or loses them; unmapped Google groups are never touched |
| A **grant** of a mapped group ends (expiry or revoke) | They leave the Google group |
| **Deactivated** (HR leaver, last day ended, the console) | Suspended and **signed out** everywhere (Google keeps its own sessions). Their mail, files and groups stay, for whoever takes over |
| **Reactivated** | Unsuspended, and their groups set again |

Agents get no Google account, and only addresses in the Google domain do. An existing Google user is linked, not
duplicated: the flow looks for Landbright's external id first, then the primary email, and writes the external id onto
what it finds. Nobody is made an administrator and nobody is deleted.

## Set it up in Google

1. **A service account** in a Google Cloud project, with the Admin SDK API enabled. Create a JSON key.
2. **Domain-wide delegation** (Admin console → Security → Access and data control → API controls → Domain-wide
   delegation): the service account's client id, with the scopes
   `https://www.googleapis.com/auth/admin.directory.user`,
   `https://www.googleapis.com/auth/admin.directory.group.member` and
   `https://www.googleapis.com/auth/admin.directory.group.readonly`.
   An `unauthorized_client` from the plugin means this step is missing or the scopes differ.
3. **An administrator to act as**: a user with the User Management admin role and group membership rights (not
   necessarily a super admin). Leave it empty only if the service account itself has an admin role.
4. **The groups** you map must exist: the flow adds and removes members, it doesn't create groups.

## Set it up in Landflow

- Start the plugin (`pnpm plugins:start` starts it with the other two; HTTP :7143, gRPC :7243).
- Credential **Google Directory (service account)**: the service account's email and private key (or paste the whole
  JSON key file), the administrator to act as, the customer (`my_customer`). *Test connection* gets a token and lists
  one user.
- Import `integrations/landflow/flows/google-people.json` (the installer does it, below). Its **Plan** Code node holds
  the map from Landbright groups to Google groups and the domain:

  ```js
  const DOMAIN = 'example.com';
  const GOOGLE_GROUPS = {
    Everyone: `everyone@${DOMAIN}`,
    Engineers: `engineering@${DOMAIN}`,
    Finance: `finance@${DOMAIN}`,
    'Payments On-call': `payments-oncall@${DOMAIN}`,
  };
  ```

  A Landbright group not in the map has no Google group; a Google group not in the map is left alone.
- The flow starts on the **Landbright Trigger** (events `identity.created`, `.activated`, `.updated`, `.deactivated`,
  `.reactivated`, `group.member_added`, `group.member_removed`); publishing it subscribes it.

### The Google Directory node

| Resource | Operation | What it does |
|---|---|---|
| User | Create or Update | Find by Landbright's id (external id), else by email (link); create with a random password, or patch what differs. *Unsuspend* optional |
| User | Get | By email or Landbright id (*When Not Found*: fail or output nothing) |
| User | Suspend | Suspend and sign out (*Sign Out* on by default). Not found: output `found: false` |
| User | Unsuspend, Sign Out | |
| User | Set Groups | Their memberships among the *managed* groups become exactly the *wanted* ones; output `added`, `removed`, `kept` |
| Group | Add Member, Remove Member | Already a member and not a member count as done |

Google's 429 and 503, and its 403 rate-limit reasons, are retried three times (2ⁿ s and jitter). A group member added
just after the user was created can get a 404 while Google catches up; it's retried too. The plugin keeps one token per
credential in memory until a minute before it expires.

## Signing in to Google through Landbright

Google's custom OIDC SSO profiles (GA since November 2025) take any OpenID provider. Google matches the person on the
ID token's `email` claim, uses the authorization code flow, and documents no PKCE, so the application is let off PKCE.

1. **In Landbright** (console → Applications → *New application*): name *Google Workspace*, the redirect URI Google's
   SSO profile page shows, grant type authorization code, **PKCE: Not required (the secret proves it)**, token endpoint
   authentication `client_secret_post`. Keep the client secret.
2. **In Google** (Admin console → Security → Authentication → SSO with third-party IdP → *Add OIDC profile*): the issuer
   (`https://<landbright>/oidc`), the client id and secret.
3. **Assign the profile** to an org unit or group (*Manage SSO profile assignments*). Start with a test group.

Only an application with a secret can be let off PKCE: an agent's application (`private_key_jwt`) can't (409), and the
console's own client can't be edited. Every other application still needs PKCE. Turning PKCE on or off is in the audit
log (`client.updated`, `pkceRequired`).

**Super administrators** never sign in through an SSO profile: Google always asks them for their Google password. Keep
them few and give them a second step in Google.

## Run it locally

There is no Google tenant here: a fake Google answers as Google's documents say, with a token endpoint that checks the
service account's JWT (signature, audience, scopes, the administrator acted as) and the Directory endpoints the plugin
uses.

```bash
pnpm fake-google        # :57995; writes the fake service account's key file to $TMPDIR/landbright-fake-google-key.json
pnpm plugins:start      # hris, landbright and gdirectory
cd e2e && LANDFLOW_OIDC_ENV_FILE=/path/to/landflow-oidc.env node landflow/install.ts
curl -s http://127.0.0.1:57995/_fake/state | jq   # users (suspended, sign-outs) and group members
```

The installer creates the *Google Directory* credential when the key file is there (`GOOGLE_KEY_FILE`,
`GOOGLE_BASE_URL`, `GOOGLE_ADMIN_EMAIL`, `GOOGLE_DOMAIN`, default `landbright.test`).

## Tests

- `integrations/landflow/plugins/google-directory/test/google.test.ts`, against the fake Google: key formats, the
  credential test, the delegation hint, create, a minimal patch, link by email, email change, 409, unsuspend, out of
  domain, suspend and sign out, set groups, propagation 404s, rate limits, per-item *Continue on fail*.
- `e2e/test/google-sso.test.ts`: an application let off PKCE (audited), Google's flow (no PKCE, the secret in the form,
  `email` and `email_verified` in the ID token), another application still refused without PKCE, PKCE back on, a
  deactivated person refused.

## Live check (2026-11-16)

Through the dev Landbright, the throwaway Landflow, the three plugins, the fake Shapes and the fake Google, with
fictitious people ([hr.md](hr.md#shapes)):

- **Joiner.** Yael Shamir added in Shapes (Engineering, starting today), Shapes' webhook → Landbright (active, source
  `shapes`, birthright groups) → Google account with department, title, manager and external id, in `everyone@` and
  `engineering@`, within about three seconds.
- **Pre-hire.** Dan Avraham, starting next week: a pre-hire in Landbright, no Google account.
- **Mover.** Yael to Finance: Google groups `everyone@`, `finance@` (out of `engineering@`), organization updated.
- **Grant.** Tal Levi asked for *Payments on-call*, the administrator approved (REQ-11): Tal in `payments-oncall@`;
  revoked: out of it.
- **Leaver.** Yael's termination date set to yesterday: Landbright deactivated her (*End dates*), Google suspended her
  account and signed her out once; her groups stayed.
- The audit chain intact.
