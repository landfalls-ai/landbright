# Research 009: Google Workspace

Read on 2026-11-16 from Google's public documentation (developers.google.com, Google's Workspace help center, which
now lives at knowledge.workspace.google.com, and the Workspace Updates blog). No Google account was used. Items marked
*inferred* are not stated by Google; the plugin is written so they fail clearly if they turn out wrong.

## Directory API

- Base: `https://admin.googleapis.com/admin/directory/v1`
  ([manage users](https://developers.google.com/workspace/admin/directory/v1/guides/manage-users)).
- Users: `POST /users` (409 when the address exists), `GET|PUT|PATCH|DELETE /users/{userKey}` (primary email, alias or
  id), `GET /users?customer=my_customer&query=…`, `POST /users/{userKey}/signOut`. `PATCH` can't clear repeated objects
  ([patch](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/patch)); setting them is
  fine.
- Search ([search users](https://developers.google.com/workspace/admin/directory/v1/guides/search-users)):
  `email=…`, `externalId=…`, `isSuspended=true`.
- [User fields](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users): `primaryEmail`,
  `name.givenName` and `name.familyName` (required, at most 60 characters each), `password` (**required on create**,
  8 to 100 ASCII characters), `externalIds[] { type: custom, customType, value }`, `organizations[] { primary,
  department, title }`, `relations[] { type: manager, value: email }`, `suspended` (writable), `suspensionReason`
  (read-only), `orgUnitPath`.
- Groups and members ([members](https://developers.google.com/workspace/admin/directory/v1/guides/manage-group-members)):
  `GET /groups?userKey=…` (the groups a user is directly in), `POST /groups/{groupKey}/members { email, role }`
  (409 when already a member), `DELETE /groups/{groupKey}/members/{memberKey}`.
- Scopes ([authorizing](https://developers.google.com/workspace/admin/directory/v1/guides/authorizing)):
  `admin.directory.user`, `admin.directory.group.member`, `admin.directory.group.readonly` (under
  `https://www.googleapis.com/auth/`).
- Service account ([service account](https://developers.google.com/identity/protocols/oauth2/service-account)): a
  JWT (RS256) with `iss` = the service account's email, `scope`, `aud` = `https://oauth2.googleapis.com/token`, `iat`,
  `exp` (at most an hour later) and `sub` = the administrator it acts as, exchanged at the token URL with `grant_type
  = urn:ietf:params:oauth:grant-type:jwt-bearer`. Without delegation granted: `unauthorized_client`. Delegation is
  granted in the Admin console (Security → Access and data control → API controls → Manage domain-wide delegation), and
  can take up to 24 hours. A service account can also be given an admin role (not super admin) of its own
  ([create credentials](https://developers.google.com/workspace/guides/create-credentials)); then no `sub` (*inferred*).
- Limits ([limits](https://developers.google.com/workspace/admin/directory/v1/limits)): 403 `userRateLimitExceeded` /
  `quotaExceeded`, 429 `rateLimitExceeded`, 503 under bulk creation; back off 2^n seconds plus jitter. User creation at
  most 10 a second per domain. A new user's propagation delay isn't documented (*inferred*: a first group add can 404;
  retried).
- Errors are `{ error: { code, message, errors: [{ domain, reason, message }] } }` (*inferred* from Google's common
  error format); the plugin branches on the status and `reason`, never on the message.

## Inbound SCIM

Generally available since 2026-07-09 for Business and Enterprise editions
([announcement](https://workspaceupdates.googleblog.com/2026/07/streamline-identity-lifecycle-management-in-Google-Workspace-with-new-inbound-SCIM-support.html)):
`https://cloudidentityscim.googleapis.com/v1/customers/{customerId}/v2/Users|Groups`, an API key as the bearer token,
and a Google Cloud organization resource; administrators can't be managed by it; no paging; attribute mapping and
whether `active: false` suspends are undocumented. Not used now (spec 009, out of scope).

## Single sign-on

- **OIDC with any provider**, generally available since 2025-11-18, every edition but Essentials Starter and Workspace
  Individual ([announcement](https://workspaceupdates.googleblog.com/2025/11/single-sign-on-with-custom-openid.html)).
  The administrator gives Google the issuer URL, a client id and a client secret; Google reads the discovery document;
  the provider's client gets Google's redirect URI. "The email claim from your IdP must match the user's primary email
  address on the Google side"; the provider "must use the authorization code flow"
  ([setting up SSO](https://knowledge.workspace.google.com/admin/apps/setting-up-sso)). Not documented: the scopes Google
  asks for, its client authentication method, PKCE.
- **SAML** works with any provider too (signed response, NameID = the primary email, HTTP-POST to the profile's ACS).
- Profiles are assigned to org units or groups. **SSO profiles never accept super administrators**
  ([migrating](https://knowledge.workspace.google.com/admin/apps/migrating-from-legacy-sso-to-sso-profiles)): they keep
  their Google password.
- Google keeps its own session after sign-in, so a leaver is also suspended and signed out by the flow; Landbright's
  deactivation alone wouldn't end a Google session already open.
