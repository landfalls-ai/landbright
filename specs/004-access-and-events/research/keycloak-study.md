# Keycloak 26.4.7 study: what Landbright should adopt

Date: 2026-11-14 · Keycloak 26.4.7 local (`landbright-keycloak`, http://127.0.0.1:58180, realm `study`) · Landbright as
of wave 1 (docs/README.md, plan.md, limitations.md, roadmap.md, reference/, spec 003 plan).

Scratchpad root (all paths below are under it):
`(session scratchpad, not kept)/`

- Screenshots: `keycloak-screens/ (a selection)` (32 admin console pages of realm `study`)
- Admin REST dumps: `…/scratchpad/kc/rest/*.json`; server info: `…/scratchpad/kc/serverinfo.json`
- Admin REST calls recorded from the console: `…/scratchpad/kc/admin-api-map.txt`; console routes from the bundle:
  `…/scratchpad/kc/console-routes.txt`
- Workflow definitions used in tests: `…/scratchpad/kc/wf-joiner.json`, `…/scratchpad/kc/wf-leaver.json`,
  `…/scratchpad/kc/wf-v2.json`
- Craft Anything project and report: `…/scratchpad/keycloak.cany`, `…/scratchpad/keycloak-craft-anything-report.md`

## Summary

Keycloak is a realm-scoped, everything-configurable IdP. Most of what it has is *configuration surface* (flows,
policies, mappers, lifetimes), and only a few pieces matter to Landbright now. Five things stand out:

1. **Keycloak has no reliable way to get events out.** Listeners run after commit, with no outbox, retry or webhook.
   Landbright already plans a transactional outbox with Standard Webhooks (spec 003). That is a real advantage, so make
   it the general event bus for identity events, not just access requests. **This is the top priority**: it is what
   lets lifecycle automation run as Landflow flows.
2. **Keycloak Workflows (experimental in 26.4, preview in 26.5) is Keycloak putting a small lifecycle engine inside
   the IdP.** It has a trigger event, conditions, and steps with delays: notify, disable, delete, set attribute, add
   required action. In this run it proved fragile: a bad condition silently disabled the workflow, definitions can't be
   edited, and workflow changes left no admin events. It also only covers users. That supports the user's rule:
   **Landbright should not build a workflow engine.** It should emit the events and expose the actions (deactivate,
   add a required action, set an attribute) as API calls that Landflow nodes use, and ship the Keycloak workflow
   recipes as Landflow templates. The one idea worth keeping in the IdP is the cheap **backstop timers** (like the
   grant expiry sweeper), not general flows.
3. **Required actions** ("this person must do X at their next sign-in": verify email, update password, set up TOTP or a
   passkey, accept terms) are the right IdP-side primitive. They are also the hook a Landflow flow needs ("the joiner
   flow adds *configure passkey*"). Landbright has an all-or-nothing tenant MFA switch and invites. A small
   `requiredActions[]` on the identity, enforced in the interaction, plus an "execute actions" email, would replace
   several limitations at once.
4. **Step-up and ACR**: Keycloak maps `acr` values to levels (`acr.loa.map`). Clients can set `minimum.acr.value`, and
   a conditional authenticator asks for more only when the requested level needs it. Landbright emits no `acr`, and its
   second step applies to everyone or no one. Adopt a two-level ACR (password, phishing-resistant) with per-application
   minimums.
5. **For agents, Keycloak 26.4 is ahead of its own token exchange.** It has *federated client authentication*: a client
   proves itself with a JWT from a SPIFFE or Kubernetes identity provider, with no stored secret. Standard token
   exchange V2 **ignores `actor_token` and emits no `act` claim** (verified). CIBA hands the "approve on another
   device" step to an external HTTP channel and waits for a callback. So Landbright's plan (RFC 8693 with `act`,
   `private_key_jwt`, and later SPIFFE) is already beyond Keycloak. **CIBA with Landflow as the authentication
   channel** is a good fit for "an agent asks, the sponsor approves in Slack".

## Gap table

| Area | Keycloak 26.4 | Landbright today | Recommendation | Priority | Where |
|---|---|---|---|---|---|
| Events out | 118 user event types, 37 admin resource types, JPA store with expiry, Event Listener SPI (after-commit, no retry); built-in listeners only log or email | Hash-chained audit log in the same transaction; outbox and webhooks only proposed in spec 003 for access events | Generalize the spec-003 outbox and Standard Webhooks into one **identity event stream** (`identity.*`, `session.*`, `credential.*`, `group.*`, `agent.*`, `client.*`) with subscriptions, retries and an event catalog | **P1** | IdP emits; Landflow consumes (Landbright Trigger) |
| Lifecycle workflows | Workflows (experimental): `on`/`reset-on` trigger, `if` expression, steps `notify-user`, `disable-user`, `delete-user`, `set-user-attribute`, `set-user-required-action` with `after` delays; user-only | Planned as Landflow JML templates (plan §4.1) | Don't build an engine. Ship the Keycloak recipes (inactive → warn → disable; joiner → required actions) as **Landflow templates** fed by `session.signed_in` / `identity.created`; add a `lastSignInAt` and an inactivity query so a scheduled Landflow flow can find people | **P1** (events + actions), templates P2 | Landflow flow |
| Required actions | 14 built-in (VERIFY_EMAIL, UPDATE_PASSWORD, CONFIGURE_TOTP, TERMS_AND_CONDITIONS, webauthn-register, …); per-user list; default-for-new-users; priority order; `max_auth_age`; app-initiated via `kc_action`; execute-actions email | None (tenant-wide "require second step"; admin re-invite for resets) | Add `requiredActions` to identities (verify email, set password, add second step, add passkey, accept terms), enforced in the interaction; `POST /api/people/:id/execute-actions` email; API + Landflow node action | **P1** | IdP (Landflow sets them) |
| Step-up / ACR | `acr.loa.map`, client `minimum.acr.value` / `default.acr.values`, `conditional-level-of-authentication` (`loa-condition-level`, `loa-max-age`), `acr` claim always present | No `acr`; `amr` only; second step is all or nothing | Emit `acr` (`urn:landbright:acr:pwd`, `…:mfa`, `…:phr` for passkeys); honor `acr_values` and a per-application minimum; max-age for re-auth | **P1** (claim + per-app minimum) | IdP |
| Brute force | Per user: failure factor, wait increment, max wait, quick-login check, temporary → permanent lockout, strategy MULTIPLE/LINEAR; admin view and unlock (`/attack-detection/brute-force/users/{id}`); events `USER_DISABLED_BY_*_LOCKOUT` | 10 failures / 15 min per email in Valkey, fails open | Keep. Add an admin "locked?/unlock" view and a `session.locked_out` event (a Landflow flow can alert or open a Landfall incident); optional per-IP limit | P2 | IdP (+ event) |
| Password policy | Composable policy string (length, history, not username/email, blacklist, regex, expiry, hash algorithm/iterations, max auth age) | Fixed: 12 characters minimum, argon2id | Add history (last N) and a breached-password check (k-anonymity or a local list) as tenant settings; skip composition rules and expiry (NIST 800-63B) | P2 | IdP |
| Realm settings: lifetimes | SSO idle 30 min / max 10 h, remember-me lifetimes, client session idle/max, offline idle 30 d, access token 5 min, code lifespans, action-token lifespans; per-client overrides | Env-fixed: session 8 h, access 1 h, refresh 14 d, ID token TTL | Tenant settings for session idle/max and access/refresh lifetimes, per-application overrides (access token TTL, refresh rotation); agents' max TTL already in plan | P2 | IdP |
| Realm settings: login/email/themes | Toggles (registration, forgot password, remember me, email as username, verify email, edit username), SMTP per realm, Freemarker themes per realm and client | Invite-only; env SMTP; one design (Landflow tokens) | Add *Forgot password* (self-service reset) and *verify email*; skip registration and themes (one design language is a feature) | P1 (forgot password), skip themes | IdP |
| Authentication flows | Tree of executions (REQUIRED / ALTERNATIVE / CONDITIONAL / DISABLED) per flow type (browser, direct grant, registration, reset credentials, first broker login, clients); conditions (user role, client scope, credential, LoA, user attribute, sub-flow executed) | Hard-coded interaction: password → second step, or passkey alone | Don't build a flow editor. Keep code paths; express choice as **policy**: per-application `minimumAcr`, per-group "require phishing-resistant" | P3 (editor: skip) | IdP |
| Roles, groups | Realm roles, client roles, composite roles, `default-roles-<realm>` composite, group hierarchy with attributes and role mappings; `fullScopeAllowed`, scope mappings | Flat groups → `roles` claim | Add **per-application role mapping** (group → app role name) so each app gets its own role vocabulary (Landflow `LANDFLOW_OIDC_ROLE_MAP` can then go away); default groups for new people ("All staff"); skip composites and hierarchy for now | P2 | IdP |
| Client scopes and mappers | Scopes with protocol mappers (user attribute, group membership, audience, hardcoded claim, role, organization, acr, amr, pairwise sub); default vs optional scopes; "evaluate" preview of a token | Fixed scopes `openid email profile roles` | Add a small, declarative claim map per application (attribute → claim; audience); a **token preview** in the console (Keycloak's *Evaluate*) is cheap and helpful | P2 | IdP |
| Identity brokering | OIDC, SAML, OAuth2, 11 social, SPIFFE, Kubernetes; first-broker-login flow (review profile, create if unique, confirm link, verify by email or re-auth); account linking | Planned after wave 1 (Google/Entra) | When built: OIDC upstream only, link by verified email under an admin setting, never auto-create unless the domain is claimed; the `identity.linked` event | P2 | IdP |
| LDAP / user federation | LDAP, Kerberos, SSSD, custom storage SPI | None | Skip (HR via Landflow plus SCIM covers the joiner path) | P3 skip | — |
| Service accounts | `serviceAccountsEnabled` creates a `service-account-<client>` user with roles; client credentials gives token with no refresh | Client credentials exists; agents have no credentials yet | Model agent and service credentials on the **identity**, not a hidden user: agent clients with `private_key_jwt`, TTL from the agent profile | P1 (wave 5 start) | IdP |
| Client policies | Profiles of executors (pkce-enforcer, secure-client-authenticator, secret-rotation, dpop-bind-enforcer, reject-ropc, consent-required, …) applied by conditions (client type, roles, scopes, grant type, updater) | Admin-registered clients only | Adopt the idea as fixed **defaults** in code (PKCE S256 required, no implicit or ROPC, `private_key_jwt` for agents); no policy engine | P3 | IdP |
| Secret rotation | `secret-rotation` executor: expiration period, rotated-secret grace period, remaining period | `rotate-secret` replaces immediately | Add a grace period (old secret valid N hours) to rotate without downtime | P2 | IdP |
| Token exchange | Standard V2 (internal → internal, audience checks, no `act`); V1 legacy preview; JWT authorization grant in 26.5 | Planned wave 5 (RFC 8693 with `act`, ID-JAG) | Build as planned: Keycloak V2 shows the audience rules (requested audience must be reachable) but skips delegation, which is the part Landbright needs | P1 (wave 5) | IdP |
| Device grant | `/auth/device`, user code page, `oauth2DeviceCodeLifespan` 600, interval 5 | Not enabled (oidc-provider supports it) | Enable for CLI agents (`claude-code` runtime) | P2 | IdP |
| CIBA | `/ext/ciba/auth`, poll/ping, external **authentication channel** (HTTP) that notifies the user, callback endpoint for the decision | None | **CIBA with Landflow as the authentication channel**: an agent asks for a person's consent, Landbright emits `ciba.requested`, a Landflow flow asks in Slack, decision recorded at Landbright (sign-in required, like spec 003's decision page) | P2 (after events) | IdP endpoint, Landflow flow for the conversation |
| PAR, DPoP | PAR on by default, `require.pushed.authorization.requests` per client; DPoP default feature | Not enabled | Enable PAR and DPoP from oidc-provider for agents and public clients; low cost | P2 | IdP |
| Sessions admin | List per user and per client, offline sessions, logout user, `logout-all`, `push-revocation` (not-before to clients), session limits authenticator (`userRealmLimit`, `userClientLimit`) | Deactivate revokes everything; no list or per-session revoke | Console: a person's sessions and grants, revoke one; back-channel logout (wave 2) | P2 | IdP |
| Impersonation | `POST /users/{id}/impersonation` (feature on by default), audited as `IMPERSONATE` | None | Skip for people. For agents, delegation through token exchange with `act` is the honest version | P3 skip | — |
| User profile | Declarative attributes with validators, per-role view/edit permissions, required-for roles/scopes, groups, annotations; unmanaged attribute policy | Fixed profile fields (department, title, site, manager, dates) | Keep fixed HR fields; maybe add a small typed `attributes` map later for HR extras and claim mapping | P3 | IdP |
| Organizations | Orgs with domains, members, invites, linked IdPs, `organization` claim and scope; identity-first login by domain | One tenant per deployment; `tenant_id` under RLS | Multi-tenant first (plan); org-by-email-domain routing when brokering arrives | P3 | IdP |
| Account console | Self-service: profile, sign-in methods (passwords, OTP, passkeys, recovery codes), devices and sessions, linked accounts, applications | No account page (limitation) | Build a minimal **account page**: methods (add, name, remove passkey or app), recovery codes, sessions | P1 | IdP |
| Agents: workload identity | SPIFFE and Kubernetes IdPs + `federated-jwt` client authenticator (`jwt.credential.issuer`, `jwt.credential.sub`); `kubernetes-service-accounts` experimental | Planned later (SPIFFE on kagent) | Adopt the exact model: register a trust domain as an issuer; an agent client names its expected `sub`; no stored secret | P2 (with wave 5) | IdP |

## Per-area detail

### 1. Realm settings

**Keycloak.** Everything is a field of `RealmRepresentation` (`GET/PUT /admin/realms/{realm}`; dump:
`kc/rest/realm.json`):

- Login options: `registrationAllowed`, `registrationEmailAsUsername`, `rememberMe`, `verifyEmail`,
  `loginWithEmailAllowed`, `duplicateEmailsAllowed`, `resetPasswordAllowed`, `editUsernameAllowed`
  (`screens/realm-settings_login.png`).
- Email: `smtpServer` map per realm (`screens/realm-settings_email.png`). Execute-actions emails fail without it:
  `PUT /users/{id}/execute-actions-email` answered 500 *Invalid sender address 'null'*.
- Themes: login, account, admin and email theme per realm and per client (`screens/realm-settings_themes.png`).
- Tokens (`screens/realm-settings_tokens.png`): `accessTokenLifespan` 300 s, `accessCodeLifespan` 60,
  `accessCodeLifespanLogin` 1800, `accessCodeLifespanUserAction` 300, `actionTokenGeneratedByAdminLifespan` 43200,
  `actionTokenGeneratedByUserLifespan` 300, `revokeRefreshToken` + `refreshTokenMaxReuse` (refresh rotation),
  `defaultSignatureAlgorithm`, device and CIBA lifetimes in `attributes` (`oauth2DeviceCodeLifespan` 600,
  `cibaExpiresIn` 120, `cibaInterval` 5, `parRequestUriLifespan` 60).
- Sessions (`screens/realm-settings_sessions.png`): `ssoSessionIdleTimeout` 1800, `ssoSessionMaxLifespan` 36000,
  remember-me variants, `clientSessionIdleTimeout`/`MaxLifespan`, `offlineSessionIdleTimeout` 2592000,
  `offlineSessionMaxLifespanEnabled`. Clients override access-token lifespan with the attribute `access.token.lifespan`
  (verified: `agent-sre` got `expires_in` 900).

**Landbright today.** Session 8 h, access token 1 h, refresh token and grant 14 days, ID token TTL from env
(`docs/sign-in.md`); no self-service reset, no verify-email, invites only.

**Gap / recommendation.** Landbright doesn't need 30 toggles. It needs (a) idle *and* absolute session limits as
tenant settings, (b) a per-application access-token TTL (agents short), (c) **forgot password** (P1, it's the most
common support request and the limitation page lists it), (d) verify email as a required action (below). Skip themes:
Landbright's single Landflow-matched design is a feature. All IdP.

### 2. Authentication flows, step-up, required actions

**Flows.** `GET /admin/realms/{realm}/authentication/flows` and `/flows/{alias}/executions` (dumps
`kc/rest/*-executions.json`, `screens/authentication.png`). A flow is a tree of executions, each with
`requirement` REQUIRED / ALTERNATIVE / CONDITIONAL / DISABLED. The default *browser* flow:
Cookie | Kerberos (disabled) | IdP redirector | Organization sub-flow | forms → Username Password Form → *Conditional 2FA*
(conditions: user configured, credential) → OTP | WebAuthn (disabled) | Recovery codes (disabled). Other built-ins:
direct grant, registration (user creation, password, reCAPTCHA, terms), reset credentials (choose user, send email,
reset password, conditional OTP reset), first broker login (review profile, create if unique or confirm link and verify
by email or re-auth, conditional org onboarding), clients, docker. The `authenticator` SPI lists 40 providers
(`kc/serverinfo.json` → providers.authenticator), including conditions `conditional-user-role` (`condUserRole`,
`negate`), `conditional-client-scope`, `conditional-credential`, `conditional-level-of-authentication`, and
`user-session-limits` (`userRealmLimit`, `userClientLimit`, `behavior`).

**Step-up (LoA).** The realm attribute `acr.loa.map` maps ACR names to levels (set to `{"silver":1,"gold":2}`;
discovery then advertised `acr_values_supported: ["silver","gold","0","1"]`). Clients set `minimum.acr.value` and
`default.acr.values`. The conditional LoA authenticator has `loa-condition-level` and `loa-max-age`. Every token
carries `acr` (verified: the `landflow` client's token had `acr: "silver"`). Feature `STEP_UP_AUTHENTICATION` is on by
default.

**Required actions.** `GET /authentication/required-actions` (`kc/rest/required-actions.json`,
`screens/authentication_required-actions.png`): CONFIGURE_TOTP, TERMS_AND_CONDITIONS (off by default),
UPDATE_PASSWORD, UPDATE_PROFILE, VERIFY_EMAIL, delete_account, UPDATE_EMAIL, webauthn-register,
webauthn-register-passwordless, VERIFY_PROFILE, delete_credential, idp_link, CONFIGURE_RECOVERY_AUTHN_CODES,
update_user_locale. Each has `enabled`, `defaultAction` (added to every new user), `priority` (order of prompts), and
config `max_auth_age` (for application-initiated actions through `kc_action=`). Per user they are a list
(`requiredActions` on the user); admins trigger them by email with `PUT /users/{id}/execute-actions-email?lifespan=`.
SPI: `required-action` (`RequiredActionProvider`/`RequiredActionFactory`: evaluate triggers, challenge, process).
Observed side effect worth copying: a user with a pending required action is refused on the direct grant
(`invalid_grant: Account is not fully set up`), so non-interactive paths can't skip them.

**Landbright today.** One hard-coded interaction (password → TOTP/passkey, or passkey alone); tenant-wide *require a
second step*; *Not now* for 30 days; resets by re-invite; `amr` only; no `acr`.

**Recommendation.**
- P1 **Required actions** in the IdP: `identity.required_actions` (`verify_email`, `set_password`,
  `add_second_step`, `add_passkey`, `accept_terms:<version>`), checked at the end of the interaction in priority
  order, plus `POST /api/people/:id/actions` (and an email link: Keycloak's "execute actions" email maps onto
  Landbright's invite token). This replaces "admin re-invites for a reset" and gives Landflow flows a lever (a joiner
  flow sets `add_passkey`; a mover into an admin group sets `add_passkey`). Emit `identity.required_action_added` and
  `…_completed`.
- P1 **ACR**: emit `acr` with two or three levels and honour `acr_values` and a per-application `minimumAcr`
  (Landfall break-glass or the console demand the phishing-resistant level). Lifts the limitation "second step is all
  or nothing".
- Skip the flow editor. Keycloak's flexibility is its biggest support cost; express choices as policy.

### 3. Brute force and password policies

**Keycloak.** Realm fields (`screens/realm-settings_security-defenses.png`): `bruteForceProtected`, `permanentLockout`,
`maxTemporaryLockouts`, `bruteForceStrategy` (MULTIPLE or LINEAR), `failureFactor` 30, `waitIncrementSeconds` 60,
`maxFailureWaitSeconds` 900, `minimumQuickLoginWaitSeconds` 60, `quickLoginCheckMilliSeconds` 1000,
`maxDeltaTimeSeconds` 43200. Test: with `failureFactor` 3, after three wrong passwords the user was locked
(`GET /attack-detection/brute-force/users/{id}` → `numFailures`, `disabled: true`, `lastIPFailure`, `lastFailure`),
the right password then still answered *Invalid user credentials* (no oracle), and the event log recorded
`LOGIN_ERROR` with `error: user_temporarily_disabled`. `DELETE` on the same path unlocks (an admin event
`DELETE USER_LOGIN_FAILURE`). SPI `bruteForceProtector`.

Password policy is one composable string (`passwordPolicy`), 18 policy types (`kc/serverinfo.json` →
passwordPolicies): `length`, `maxLength`, `digits`, `lowerCase`, `upperCase`, `specialChars`, `notUsername`,
`notEmail`, `passwordHistory`, `passwordBlacklist`, `regexPattern`, `forceExpiredPasswordChange`, `passwordAge`,
`hashAlgorithm`, `hashIterations`, `maxAuthAge`, `recoveryCodesWarningThreshold`. Set in the test:
`length(12) and notUsername() and passwordHistory(3) and hashAlgorithm(argon2)`.

**Landbright today.** 10 failures per email per 15 minutes in Valkey (fails open); same answer and timing for wrong
email or password; 12-character minimum; argon2id.

**Recommendation.** P2: an admin "locked out / unlock" action and a `session.locked_out` event (a Landflow flow can
notify the person or open a Landfall incident on a spike); password history and a breached-password check as tenant
settings. Skip composition rules and forced expiry (contrary to NIST SP 800-63B). IdP, with the event for Landflow.

### 4. Events

**Keycloak.** Two streams.
- *User events* (`GET /admin/realms/{realm}/events`, `screens/events.png`): 118 types in the `eventType` enum, 93
  saved by default (`kc/rest/events-config.json`); not saved by default: `REFRESH_TOKEN`, `INTROSPECT_TOKEN`,
  `USER_INFO_REQUEST`, `PUSHED_AUTHORIZATION_REQUEST`, `VALIDATE_ACCESS_TOKEN`, `IDENTITY_PROVIDER_RESPONSE`, … . Fields
  (class `org.keycloak.events.Event`): `id`, `time`, `type`, `realmId`, `realmName`, `clientId`, `userId`,
  `sessionId`, `ipAddress`, `error`, `details` (e.g. `auth_method`, `grant_type`, `client_auth_method`, `username`).
- *Admin events* (`GET /admin-events`, `screens/events_admin.png`): `id`, `time`, `realmId`, `authDetails` (realm,
  client, user, IP of the admin), `operationType` (CREATE, UPDATE, DELETE, ACTION), `resourceType` (37 values: USER,
  GROUP_MEMBERSHIP, REALM_ROLE_MAPPING, CLIENT, ORGANIZATION_MEMBERSHIP, USER_SESSION, USER_LOGIN_FAILURE, …),
  `resourcePath` (`users/{id}/groups/{gid}`), `representation` (JSON of the change, secrets masked as `***`), `error`,
  `details`. Observed: `ACTION USER users/{id}/logout`, `ACTION REALM logout-all`, `ACTION REALM push-revocation`.
- Config: `PUT /events/config` (`eventsEnabled`, `eventsExpiration` seconds, `enabledEventTypes`,
  `adminEventsEnabled`, `adminEventsDetailsEnabled`, `eventsListeners`) (`screens/realm-settings_events_listeners.png`).
  Storage is the `eventsStore` SPI (JPA); expiry is purged by a scheduled task.
- **Event Listener SPI** (`org.keycloak.events.EventListenerProvider`): two callbacks, one per user event and one per
  admin event with an "include representation" flag; the factory can declare itself *global*. Built in: `jboss-logging`,
  `email`, and `workflow-event-listener` (global: trying to add it per realm answered *Global event listeners not
  allowed in realm specific configuration*). Delivery happens through `EventListenerTransaction` on commit: the events
  are only handed to listeners after the transaction commits, and a listener that fails to deliver to a remote system
  just loses the event. There's no outbox, retry or webhook in 26.4. The common answer is a community plugin
  (webhooks, Kafka, or a polling job on `/events`).
- **Gap observed**: creating, updating and binding workflows produced **no admin events** (the admin-event log shows
  everything else done in the session, but not the workflow calls).

**Landbright today.** Hash-chained audit log written in the same transaction (`identity.created`,
`group.member_added`, `client.secret_rotated`, `session.signed_in`, `session.sign_in_failed`, …). Spec 003 designs
`outbox_event` + delivery worker + Standard Webhooks + subscriptions API (`POST /api/v1/webhooks`), but only for access
events.

**Recommendation (P1, IdP emits, Landflow consumes).** Make the outbox the single path for *all* audit events that
matter outside: an event catalog (name, schema in `libs/contracts`, whether it's delivered), subscriptions filtered by
type, the Landbright Trigger offering them all. Keep Keycloak's split (people's sign-in events vs administrative
changes) as an event `category`, carry `actor` / `subject` / `client` / `ip` / `details`, and never put secrets or
full representations in the payload (link to the resource instead, as spec 003 says). Add the high-value types
Keycloak has and Landbright lacks: `session.signed_out`, `session.locked_out`, `credential.password_changed`,
`identity.required_action_completed`, `client.token_issued` (sampled or off by default, Keycloak doesn't save
`REFRESH_TOKEN` by default either). Retention: Keycloak expires events; Landbright's audit is a ledger, so keep it but
let deliveries expire.

### 5. Workflows (the one that matters most for "flows are Landflow flows")

**Status.** In 26.4.7 the feature `WORKFLOWS` is *experimental* and off. I enabled it by editing
`deploy/keycloak/compose.yml` to `--features=preview,workflows,kubernetes-service-accounts,dynamic-scopes,client-types`
and restarting only the `landbright-keycloak` project. Serverinfo then showed the SPIs `workflow`
(`event-based-workflow`, `user-creation-time-workflow`, `user-refresh-time-workflow`), `workflow-condition`
(`expression`, `has-identity-provider-link`, `has-role`, `has-user-attribute`, `is-member-of`), `workflow-step`
(`delete-user`, `disable-user`, `notify-user`, `set-user-attribute`, `set-user-required-action`), `workflow-state`
(`jpa`). The console gains **Configure → Workflows** with a list (name, id, enabled) and a create page that's only a
JSON editor (`screens/workflows.png`, `screens/workflows_new.png`). Keycloak 26.5 moved it to *preview* and added YAML,
groups by path, event properties in conditions, cancel and restart an execution, scheduled workflows, and past-tense
event names (release notes); its blog lists more steps and triggers (group, role, organization changes) on the roadmap.

**Model** (classes `org.keycloak.representations.workflows.WorkflowConstants`, `models.workflow.Workflow`,
`WorkflowStep`, `ResourceOperationType`, `ResourceType`, `WorkflowStateEntity`; JSON verified through the REST API):

- A workflow is a realm *component* (it shows up in `/components` as `WorkflowProvider`, steps as child
  `WorkflowStepProvider` components). Fields: `name`, `uses` (provider, default `event-based-workflow`), `on` (trigger),
  `reset-on` (an event that restarts the chain), `if` (list of conditions; `expression` takes a boolean expression over
  condition calls with AND, OR, `!` and parentheses), `enabled`, `recurring`, `scheduled`, `error`, `state`.
- Steps: `uses`, `after` (milliseconds after the previous step, the first counted from the trigger), `priority`
  (order, assigned on create), `with` (config: `notify-user` takes `reason`, `custom_subject_key`, `custom_message`;
  `set-user-required-action` takes `action`; `set-user-attribute` takes `user.attribute.<name>` keys).
- Triggers (`ResourceOperationType`): `USER_ADD`, `USER_LOGIN`, `USER_FEDERATED_IDENTITY_ADD`,
  `USER_FEDERATED_IDENTITY_REMOVE`, `USER_GROUP_MEMBERSHIP_ADD`, `USER_ROLE_ADD`, `AD_HOC`. Resource type: `USERS`
  only. Events come from both user events and admin events through the global `workflow-event-listener`.
- State: one row per (workflow, resource) with `executionId`, `workflowId`, `workflowProviderId`, `resourceId`,
  `resourceType`, `scheduledStepId`, `scheduledStepTimestamp`. A background task (`WorkflowRunnerScheduledTask`) runs
  due steps every `step-runner-task-interval` (default **12 hours**; option
  `--spi-events-listener--workflow-event-listener--step-runner-task-interval`).
- Admin REST (`/admin/realms/{realm}/workflows`): `GET` list, `POST` create (201 + Location), `POST` a set,
  `GET/PUT/DELETE /{id}`, `POST /{id}/bind/USERS/{userId}` with a not-before body (verified 204: ad hoc enrolment of an
  existing user), `/{id}/steps` (`GET`, `POST` with a position, `GET/DELETE /{stepId}`).

**What I ran** (`kc/wf-joiner.json`, `kc/wf-leaver.json`, `kc/workflows-list.json`):
- *Onboard new users* (`on: USER_ADD`, steps `set-user-required-action CONFIGURE_TOTP` and `set-user-attribute`):
  creating `dana` immediately gave her `requiredActions: [CONFIGURE_TOTP]` and the attribute. **This worked as
  intended.**
- *Disable inactive users* (`on: USER_LOGIN`, `reset-on: USER_LOGIN`, `if: !has-role("realm-management/realm-admin")
  AND is-member-of("engineering")`, `notify-user` after 30 d, `disable-user` after 30 more): at the first matching event
  the engine **disabled the workflow** with only a log line (*Group with id engineering does not exist*: in 26.4
  `is-member-of` takes a group id, not a name; 26.5 accepts paths). The console then showed *Disabled*.
- `PUT` to fix the condition was refused (*Workflow update can only change 'name' and 'enabled'*). Definitions are
  immutable, so a change means delete and recreate. The refused `PUT` also **dropped the workflow's `name`** (the list
  then showed it without a name).
- None of these admin calls appeared in the admin events.

**Landbright today.** No engine; plan §4.1 already puts joiner/mover/leaver in Landflow templates driven by HR
triggers; spec 003 puts approvals in Landflow with Landbright as the record and backstop.

**Recommendation.** Keycloak's Workflows is the strongest evidence for the user's rule. Even Keycloak's team ended up
building trigger → condition → delayed steps, and the result is a weak, user-only, JSON-only workflow engine inside an
IdP, with a 12-hour tick, no visible run history and no audit. Landflow already does that job better (canvas, durable
waits, runs, approvals, Slack/email). So:

1. **Landbright emits the trigger events** Keycloak uses, with the same meaning: `identity.created` (USER_ADD),
   `session.signed_in` (USER_LOGIN), `group.member_added` (USER_GROUP_MEMBERSHIP_ADD), `identity.linked` /
   `identity.unlinked` (federated identity add/remove), plus the ones Keycloak's roadmap lacks: `group.member_removed`,
   `identity.updated` (with changed fields), `identity.deactivated`, `agent.suspended`, `sponsor.left`. (P1)
2. **Landbright exposes the steps as API actions** that the Landbright node calls: deactivate (exists), add required
   action (new), set attribute/profile field (exists via PATCH), send notification (Landflow does this itself),
   delete (an erasure action, P3). (P1)
3. **Inactivity needs state in the IdP, not a timer per person**: store `lastSignInAt` on the identity and offer
   `GET /api/v1/people?inactiveSince=`. A *scheduled* Landflow flow (daily) finds people, warns them, waits, re-checks
   and deactivates. That replaces Keycloak's `reset-on` trick with an explicit re-check, which is more robust. (P1 for
   the field and query, P2 for the template)
4. **Ship Keycloak's two canonical recipes as Landflow templates** in the `landbright` plugin's `flows/`: *Disable
   inactive people* and *Onboard: require passkey and verify email*. (P2)
5. Keep in the IdP only timers that are **safety backstops** (grant expiry sweeper, invite expiry), never business
   logic. (Already the plan.)

### 6. Roles, groups, client scopes, protocol mappers

**Keycloak.** Realm roles (`GET /roles`), client roles, composite roles (`/roles-by-id/{id}/composites`), and
`defaultRole` = `default-roles-study` (composite of `offline_access`, `uma_authorization`, account roles) that every
new user gets. Groups are hierarchical (`/groups`, sub-groups, paths like `/engineering`), carry `attributes` and role
mappings; `default-groups` adds new users to groups (`screens/groups.png`, `screens/roles.png`). Client scopes
(`kc/rest/client-scopes.json`, `screens/client-scopes.png`): `basic` (sub, auth_time), `roles`
(`realm_access.roles`, `resource_access.${client_id}.roles`, audience resolve), `profile`, `email`, `acr`,
`organization`, `service_account`, `microprofile-jwt`, `web-origins`, `offline_access`, `phone`, `address`; each is a
bag of protocol mappers (23 OIDC mapper types: `oidc-usermodel-attribute-mapper`, `oidc-group-membership-mapper`,
`oidc-audience-mapper`, `oidc-hardcoded-claim-mapper`, `oidc-sha256-pairwise-sub-mapper`, `oidc-acr-mapper`,
`oidc-amr-mapper`, …). Scopes are default or optional per client, with `include.in.token.scope`; `fullScopeAllowed`
and scope mappings limit which roles go into a client's token. The console's *Evaluate* tab generates an example token
(`/clients/{id}/evaluate-scopes/generate-example-access-token`).

**Landbright today.** Flat groups; the `roles` scope emits group names as `roles` and `groups`; expired JIT
memberships left out; Landflow maps names to its roles with `LANDFLOW_OIDC_ROLE_MAP`.

**Recommendation.** P2: per-application role mapping (`application_role`: group → role name for that app, emitted
in `roles` only to that app). It's Keycloak's client roles without the generality, and it keeps role vocabulary next to
the app. Default groups for new people (birthright) are already in the plan via HR flows; a tenant-level "default
groups" setting is a cheap fallback. A token preview in the console is cheap and valuable. Skip composites,
hierarchy and a general mapper engine for now. IdP.

### 7. Identity brokering and federation

**Keycloak.** `GET /identity-provider/instances` (`screens/identity-providers.png`); providers: `oidc`,
`keycloak-oidc`, `oauth2`, `saml`, `spiffe`, `kubernetes`, and social (Google, Microsoft, GitHub, GitLab, LinkedIn,
…). Options: `trustEmail`, `storeToken`, `linkOnly`, `hideOnLogin`, `syncMode`, first-login flow, mappers
(`identity-provider-mapper` SPI). The *first broker login* flow decides create vs link (review profile → create if
unique, else confirm link and verify by email or re-authentication, then optional organization onboarding).
Authenticators `idp-auto-link`, `idp-detect-existing-broker-user`, `identity-provider-redirector`
(`defaultProvider`). Organizations can own IdPs and route by email domain. User federation: LDAP, Kerberos, SSSD,
plus `user-storage` SPI (`screens/user-federation.png`).

**Landbright today.** None; Google/Entra federation planned after wave 1.

**Recommendation.** P2 when built: upstream OIDC (Google, Entra) only; link to an existing person only by a verified
email from an issuer an admin trusts for that domain (Keycloak's "confirm link + verify" is what you need when you
don't trust the upstream; with a claimed domain you can link directly); never create people from upstream sign-in
(people come from HR via Landflow, which keeps one joiner path). Emit `identity.linked`. Skip LDAP. IdP.

### 8. Clients

**Service accounts.** `serviceAccountsEnabled: true` creates a hidden user `service-account-<clientId>`. A
client-credentials token for the test client `agent-sre` had `sub` = that user, `azp: agent-sre`, `client_id`,
`clientHost`, `clientAddress`, default realm roles, `scope: profile email`, and no refresh token
(`refresh_expires_in: 0`).

**Client authenticators** (`/authentication/client-authenticator-providers`): `client-secret`, `client-jwt`
(private_key_jwt), `client-secret-jwt`, `client-x509` (mTLS), `federated-jwt` (*Signed JWT - Federated*, preview).

**Client policies** (`/client-policies/profiles?include-global-profiles=true`, `/client-policies/policies`,
`screens/realm-settings_client-policies_profiles.png`): profiles are lists of *executors* (32: `pkce-enforcer`,
`secure-client-authenticator`, `secret-rotation`, `dpop-bind-enforcer`, `reject-ropc-grant`,
`reject-implicit-grant`, `consent-required`, `holder-of-key-enforcer`, `use-lightweight-access-token`,
`secure-ciba-*`, `secure-par-content`, …); policies apply profiles when *conditions* match (12: `client-type`,
`client-roles`, `client-scopes`, `grant-type`, `client-attributes`, `client-updater-source-*`, `acr-condition`, …).
Global profiles cover FAPI 1/2 and OAuth 2.1.

**Secret rotation** (preview, on): the `secret-rotation` executor with `expiration-period`,
`rotated-expiration-period` (how long the old secret keeps working), `remaining-rotation-period`.

**Token exchange.** `TOKEN_EXCHANGE_STANDARD_V2` default; the client attribute `standard.token.exchange.enabled`.
Verified: (1) exchanging Dana's token for `audience=agent-sre` failed with *Requested audience not available*, because
the audience must be reachable through the requester's scopes/roles; (2) exchanging with an `actor_token` succeeded
but the token had **no `act` claim** and the same `sub`/`azp`: V2 is impersonation-style, not delegation. 26.5 adds a
JWT Authorization Grant (RFC 7523) and downscoping.

**Device grant** (`/protocol/openid-connect/auth/device`): returned `device_code`, `user_code` (`BJQN-YNZR`),
`verification_uri(_complete)`, `expires_in` 600, `interval` 5.

**CIBA** (`/protocol/openid-connect/ext/ciba/auth`, poll and ping): the request with `login_hint=dana`,
`binding_message=approve-REQ-128` failed with *Failed to send authentication request*, because Keycloak doesn't notify
users itself. The `ciba-auth-channel` SPI (`ciba-http-auth-channel`) POSTs the request to an external URL you
configure, and that service tells Keycloak the outcome through a callback endpoint (succeeded / unauthorized /
cancelled). Realm attributes: `cibaBackchannelTokenDeliveryMode`, `cibaExpiresIn`, `cibaInterval`,
`cibaAuthRequestedUserHint`.

**PAR, DPoP.** PAR endpoint `/ext/par/request` with `require.pushed.authorization.requests` per client; DPoP algorithms
advertised; `dpop.bound.access.tokens` per client.

**Landbright today.** Admin-registered clients, code + PKCE, refresh, client credentials, introspection, revocation;
`rotate-secret` immediate; no token exchange, device, CIBA, PAR or DPoP (oidc-provider supports device, CIBA, PAR,
DPoP, but not token exchange, which needs a custom grant).

**Recommendation.**
- P1 (wave 5 start): agent clients with `private_key_jwt` and TTLs from the agent profile; token exchange with `act`
  as planned (Keycloak's V2 shows the audience rules but skips delegation).
- P2: secret rotation with a grace window; device grant for CLI agents; PAR + DPoP for agents.
- P2: **CIBA with Landflow as the authentication channel.** It's the standard shape of "an agent wants to act for Dana;
  Dana approves on her phone". Landbright receives the CIBA request, emits `ciba.requested` through the outbox, a
  Landflow flow asks Dana (Slack/email with a link), Dana decides on a Landbright page where she signs in (the same
  rule spec 003 uses for approvals), and the agent polls the token endpoint. The IdP owns the protocol and the decision;
  Landflow owns the conversation.
- P3: client-policy engine; bake the defaults into code instead.

### 9. Sessions, impersonation, user profile, organizations, account console

**Sessions.** `GET /users/{id}/sessions` (id, username, IP, start, lastAccess, rememberMe, clients map),
`/users/{id}/offline-sessions/{clientId}`, `POST /users/{id}/logout`, `DELETE /sessions/{id}`,
`/client-session-stats`, `POST /logout-all`, `POST /push-revocation` (sends not-before to clients' admin URLs); the
console's Sessions page uses `ui-ext/sessions` (`screens/sessions.png`). `user-session-limits` caps sessions per user
per realm/client. Persistent user sessions are a default feature (sessions survive restarts).

**Impersonation.** `POST /users/{id}/impersonation` (200; feature on by default) gives the admin a session as the user,
recorded as an `IMPERSONATE` event.

**User profile.** `GET/PUT /users/profile` (`kc/rest/user-profile.json`, `screens/realm-settings_user-profile.png`):
attributes with `validations` (`length`, `email`, `person-name-prohibited-characters`,
`username-prohibited-characters`, `up-username-not-idn-homograph`), `permissions` (`view`/`edit` for `admin`/`user`),
`required` (by roles or scopes), `multivalued`, `annotations`, attribute `groups`; `unmanagedAttributePolicy`.

**Organizations** (default on; `organizationsEnabled`): `POST /organizations` with `name`, `alias`, `domains[]`
(`verified`), `attributes`; `POST /organizations/{id}/members` with a user id (201); members, invites
(`INVITE_ORG` event), linked IdPs, `organization` scope and claim, identity-first login by domain
(`screens/organizations.png`).

**Account console** (`/realms/{realm}/account`, Account REST API, `ACCOUNT_V3`): personal info, signing in (password,
OTP, passkeys, recovery codes), device activity (sessions, sign out), linked accounts, applications (consents).

**Landbright today.** Deactivation revokes everything; no session list; no account page (listed limitation); fixed
profile fields; one tenant.

**Recommendation.** P1: a minimal **account page** in the IdP (sign-in methods: add, name, remove passkeys and the app;
recovery codes; my sessions with sign out). It removes the two biggest wave-1 limitations and gives people somewhere
to finish required actions. P2: admin session list and revoke-one. Skip impersonation (for agents, `act`-based
delegation is the honest version). P3: declarative profile, organizations (multi-tenant first).

### 10. Agents and other notable features

Enabled features seen in serverinfo (`kc/serverinfo.json`): `SPIFFE`, `CLIENT_AUTH_FEDERATED`, `KUBERNETES_SERVICE_ACCOUNTS`
(experimental, enabled for the study), `TOKEN_EXCHANGE_STANDARD_V2`, `DPOP`, `PAR`, `CIBA`, `DEVICE_FLOW`, `PASSKEYS`,
`RECOVERY_CODES`, `STEP_UP_AUTHENTICATION`, `ORGANIZATION`, `PERSISTENT_USER_SESSIONS`, `OPENTELEMETRY`,
`ADMIN_FINE_GRAINED_AUTHZ_V2`, `CLIENT_TYPES` and `DYNAMIC_SCOPES` (experimental). Not enabled: `OID4VC_VCI`,
`TRANSIENT_USERS`, `TOKEN_EXCHANGE_EXTERNAL_INTERNAL_V2`.

- **Federated client authentication** (class `FederatedJWTClientAuthenticator`, id `federated-jwt`): register an
  identity provider of type `spiffe` (config `issuer` = trust domain such as `spiffe://landflow.local`,
  `bundleEndpoint` = SPIFFE bundle or JWKS URL; `screens/identity-providers_spiffe_add.png`) or `kubernetes` (issuer,
  optional JWKS URL). Then a client sets `clientAuthenticatorType: federated-jwt` with attributes
  `jwt.credential.issuer` (the IdP alias) and `jwt.credential.sub` (the expected SPIFFE ID or service account). Created
  and accepted: IdP `spiffe-landflow`, client `agent-sre-spiffe` with sub
  `spiffe://landflow.local/agent/sre-investigator`. That's the "no standing secrets" model plan §4.3 wants for kagent,
  and a clean data model to copy: issuer registry plus per-client expected subject.
- **Client types** (experimental): a `service-account` type derived from `oidc` that fixes which settings apply
  (`kc/rest/client-types.json`). Matches Landbright's identity kinds (`person`/`agent`/`service`): make the
  application form depend on the kind instead of exposing every switch.
- **MCP**: 26.5 published a guide for Keycloak as an MCP authorization server and lets scopes be hidden from discovery.
  Landbright's plan (CIMD client ids, RFC 8707 `resource`, ID-JAG) is ahead.

## Proposed order of work

1. **Identity event stream (generalize spec 003's outbox).** One outbox, an event catalog in `libs/contracts`,
   subscriptions API, Standard Webhooks delivery, the Landbright Trigger offering every event. Everything else that's
   "a flow" depends on it, and it's where Keycloak is weakest (after-commit listeners, no retry, workflow changes not
   audited). *IdP emits → Landflow.*
2. **Required actions + execute-actions link + forgot password.** `requiredActions` on identities enforced in the
   interaction (verify email, set password, add second step, add passkey, accept terms); an emailed action link built on
   the invite token; self-service reset as the same mechanism. Exposed as a Landbright-node action so joiner/mover
   flows can require a passkey. *IdP, driven by Landflow.*
3. **Account page.** Sign-in methods (add, name, remove passkeys and the app), recovery codes, my sessions. Lifts the
   "no account page" and "admin reset only" limitations and is where required actions get done. *IdP.*
4. **ACR and per-application minimums.** Emit `acr`, accept `acr_values`, a per-application `minimumAcr` and re-auth
   max age; the phishing-resistant level for the console and break-glass. Lifts "second step is all or nothing" ahead
   of wave 6. *IdP.*
5. **Lifecycle flows as Landflow templates, not an IdP engine.** `lastSignInAt` + an inactivity query, the
   `identity.*`/`group.*`/`session.*` events from item 1, and two templates mirroring Keycloak Workflows' recipes
   (*Disable inactive people*: warn, wait, re-check, deactivate; *Onboard*: require passkey and verify email, add
   birthright groups). *Landflow flow fed by Landbright events.*
6. **Agent client authentication without secrets** (start of wave 5): `private_key_jwt` agent clients now, then the
   Keycloak-style issuer registry (SPIFFE/Kubernetes) with an expected subject per agent. Token exchange with `act`
   follows, then CIBA with Landflow as the authentication channel for sponsor approval. *IdP; the CIBA conversation is a
   Landflow flow.*

Why this order: 1 is the base for every Landflow-side process; 2 and 3 close the user-facing gaps people hit first
and give flows something to act on; 4 is small and unblocks Landfall and console hardening; 5 shows the
"Landbright emits, Landflow acts" split working on a real case; 6 starts the agent wave on the strongest idea Keycloak
has.

## Craft Anything: what I used and what didn't work

Project: `…/scratchpad/keycloak.cany`; generated report:
`…/scratchpad/keycloak-craft-anything-report.md` (`report --out`, 8 findings, 39 evidence records).

Used:
- `commands`, `capabilities`, `<tool> --help`.
- `java-classes-find` (`--deep`) on `keycloak-services`, `server-spi`, `server-spi-private`, `model-jpa`, `core` jars:
  workflow, event and federated-auth classes.
- `java-class-show` (`--deep`, with and without `--decompile`): fields, constants and method signatures of
  `WorkflowConstants`, `Workflow`, `WorkflowStep`, `ResourceOperationType`, `ResourceType`, `WorkflowStateEntity`,
  `WorkflowsEventListenerFactory`, `Workflows/Workflow/WorkflowStepsResource`, `EventListenerProvider(Factory)`,
  `EventListenerTransaction`, `Event`, `AdminEvent`, `FederatedJWTClientAuthenticator`.
- `web-walkthrough-record` (`--deep --allow-run`): logged in to the admin console and visited 27 pages of realm `study`
  with screenshots and network capture (87 steps), the source of `screens/*.png` and `kc/admin-api-map.txt`; a second
  run attached over CDP to a scratch Chrome to capture the workflow, events-listener and SPIFFE pages.
- `web-site-open` (login page of realm `study`).
- `web-page-js-analyze` (`--load-source-maps`, attached over CDP): 341 console routes, 15 endpoint call sites, vendors
  (Vite, React Router 6.30.1); `kc/console-routes.txt`.
- `core-brief-write`, `core-finding-record` (8 findings), `core-evidence-show`, `report`.

Didn't work or needed workarounds:
- The CLI's browser doesn't outlive one invocation: `web-site-open` followed by `web-page-js-analyze` failed with
  *no browser is available: no endpoint was given*. Workaround: start a headless Chrome with
  `--remote-debugging-port=9333` and a scratch profile, log in with `web-walkthrough-record --cdp-endpoint`, then run
  `web-page-js-analyze --cdp-endpoint --target-id`. That Chrome was stopped afterwards.
- Hash-only `goto`s inside the admin console kept the previous realm (the first run mapped `master`); a full page load
  between pages fixed it. `goto about:blank` is rejected (http/https/file only).
- `web-walkthrough-record` returns screenshots as base64 in its JSON rather than files, and network outlines rather
  than a HAR, so `web-recording-show` (which reads a HAR) had nothing to read. Endpoints were mapped from the outlines
  instead. Response bodies were mostly unavailable (*No resource with given identifier found*).
- `java-class-show` doesn't list method annotations, so JAX-RS `@Path` values weren't visible; I found the REST paths by
  calling the live API.
- `--project` must be passed as separate arguments (zsh doesn't split a `$P` variable); I used a small wrapper script.
- The evidence ledger only holds Craft Anything's own observations. The curl calls against the admin REST API (the
  workflow, token exchange, CIBA, brute-force and events tests) are saved as files under `kc/` but aren't ledger
  entries.
- Not used, as asked: `rebuild`, `chat`. Not needed: `web-site-capture`, `web-page-states-capture`.

Sources (public docs): [Workflows in Keycloak 26.4 (blog)](https://www.keycloak.org/2025/10/workflows-experimental-26-4),
[Keycloak 26.5.0 release](https://www.keycloak.org/2026/01/keycloak-2650-released),
[Self-hosted human and machine identities in Keycloak 26.4 (CNCF)](https://www.cncf.io/blog/2025/11/07/self-hosted-human-and-machine-identities-in-keycloak-26-4/).

Local changes: `deploy/keycloak/compose.yml` command now
`['start-dev', '--http-port=8080', '--features=preview,workflows,kubernetes-service-accounts,dynamic-scopes,client-types']`
(the only repo file touched); the Keycloak data is in-memory H2, so realm `study` disappears on the next restart.
