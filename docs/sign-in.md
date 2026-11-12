# Sign-in

Landbright is an OpenID Connect provider. Applications (Landflow, Landfall, Landbright's own console) send people to
it to sign in and get back an ID token that says who they are and which groups they are in.

## The issuer

`http://localhost:4402/oidc` locally (`<LANDBRIGHT_IDP_URL>/oidc`; `localhost`, not `127.0.0.1`, because passkeys
need a domain). Discovery is at
`/oidc/.well-known/openid-configuration`, keys at `/oidc/jwks`.

| | |
|---|---|
| Flows | Authorization code with PKCE (required, S256), refresh tokens, client credentials |
| Also | Introspection, revocation, userinfo (`/oidc/me`), RP-initiated logout (`/oidc/session/end`) |
| Signing | RS256; the key is generated on first start and stored sealed in Postgres |
| Scopes | `openid`, `email`, `profile`, `roles`, `offline_access` |
| Lifetimes | Session 8 h, access token 1 h, refresh token and grant 14 days |

| Scope | Claims (in the ID token and from userinfo) |
|---|---|
| `openid` | `sub`: the identity's id; `amr`: how they signed in ([below](#how-the-token-says-how)) |
| `email` | `email`, `email_verified` (true: an administrator or an HR source entered it) |
| `profile` | `name`, `given_name`, `family_name`, `preferred_username` (the email) |
| `roles` | `roles` and `groups`: the names of the person's groups, sorted; expired just-in-time memberships left out |

Only active people can sign in. There is no consent screen: an application exists only because an administrator
registered it, so it gets the scopes it asks for.

## Signing in

The pages are server-rendered by the identity plane, in Landflow's tokens, under a CSP of `default-src 'none'` with
this origin's stylesheet and one script, and data: images for the QR code (`apps/idp/src/pages`). People sign in with
email and password and then a second step, or with a passkey alone. The stylesheet's and the script's URLs carry a
hash of their content, so a changed page never runs with an old cached copy.

- A wrong email and a wrong password get the same answer, and take the same time (a decoy argon2 hash).
- Ten failures for one email in 15 minutes lock that email for the rest of the window. The counter lives in Valkey;
  if Valkey is down, sign-in still works without it.
- Every success and failure is in the audit log (`session.signed_in` with the methods used,
  `session.sign_in_failed` with the step that failed).

## The second step

After the password: a code from an authenticator app (TOTP: 6 digits, 30 seconds, SHA-1, one step of clock drift
either way) or a passkey.

- **Someone with one set up** is asked for it after their password: the code page (with *Use your passkey instead* if
  they have both), or the passkey page. A wrong code or passkey counts toward the same lockout as a wrong password. A
  code is accepted once: the step it belongs to is stored, and only a later step works after it.
- **Someone without one** is offered it: a QR code and the key to type, then a code to confirm; or *Use a passkey
  instead*. *Not now* signs them in and isn't asked again for 30 days (kept in Valkey; if Valkey is down they are asked
  again).
- **Settings → Require a second step for everyone** (`tenant.mfa_required`) removes *Not now*: anyone without one sets
  one up at their next sign-in before going on.
- **Reset second step** on a person's page deletes their app and their passkeys, for a lost phone or laptop; they are
  offered a new second step at their next sign-in (and must set one up when it's required).

The app's key is sealed with AES-256-GCM under a key derived from `LANDBRIGHT_SECRET_KEY`, like the signing key.
Audit events: `credential.totp_added`, `credential.passkey_added`, `credential.second_step_reset`,
`tenant.sign_in_changed`.

## Passkeys

WebAuthn passkeys, verified with `@simplewebauthn/server`. The relying-party id is the host of `LANDBRIGHT_IDP_URL`
(`localhost` locally); browsers refuse IP addresses, so with an IP there the pages don't offer passkeys at all.

- **Sign in with a passkey** on the sign-in page needs no email: passkeys are discoverable, and the browser offers the
  ones it holds for this site. User verification (a PIN or biometric) is required, so a passkey alone is two factors
  and satisfies *Require a second step*.
- **Add one** when offered a second step (*Use a passkey instead*). There is no account page to add one later yet
  (docs/limitations.md).
- Each ceremony's challenge is kept in Valkey for 10 minutes and taken when the answer comes back, so an answer works
  once; the authenticator's signature counter is stored and must move forward. Only the public key is stored.
- The pages' only script (`/assets/passkey.js`) runs the ceremony and submits the form; without it, or in a browser
  without WebAuthn, the passkey buttons stay hidden.

## How the token says how

The ID token's `amr` (RFC 8176), so an application can ask for a second step itself:

| Signed in with | `amr` |
|---|---|
| Password | `["pwd"]` |
| Password and an authenticator app | `["pwd", "otp", "mfa"]` |
| Password and a passkey | `["pwd", "pop", "mfa"]` |
| A passkey alone | `["pop", "mfa"]` |

## Passwords

Administrators never set or see passwords. Adding a person emails them a link (`<IDP_URL>/invite/<token>`, 72 hours,
single use; only the token's SHA-256 is stored) to choose one of at least 12 characters, hashed with argon2id. Sending
a new invite cancels the old one, which is also how a password is reset. Locally, the mail is in Mailpit at
<http://127.0.0.1:57825>.

## The console signs in the same way

Landbright's console is an OIDC client of its own identity plane (`landbright-console-<tenant>`, created by
`pnpm db:setup`). Control does the protocol work and keeps the tokens; the browser gets only an HttpOnly, SameSite=Lax
cookie `lb_session` (8 hours, extended on use, stored in Valkey).

`/api/auth/login?returnTo=/people` → the identity plane's sign-in page → `/api/auth/callback` → back to `/people`.
`returnTo` must be a path on the console. Sign-out (`POST /api/auth/logout`) ends the console session and sends the
browser to the identity plane's sign-out page, which ends the Landbright session too.

The console is for members of *Landbright Admins*; anyone else who signs in is told so. Membership and status are
checked on every request, so removing an administrator takes effect at once.

## Connecting Landflow

Landflow already speaks OIDC (`apps/web/src/lib/server/auth/oidc.ts` in the landflow repository). No code changes:

1. In the console, **Groups → New group**: e.g. *Landflow Editors* and *Landflow Admins*. Add people to them.
2. **Applications → Register application**: name *Landflow*, redirect URI `<Landflow's public URL>/api/auth/oidc/callback`
   (locally `http://localhost:3000/api/auth/oidc/callback`).
3. The dialog shows the client secret once, with the lines for Landflow's `.env`:

   ```bash
   LANDFLOW_OIDC_ISSUER=http://localhost:4402/oidc
   LANDFLOW_OIDC_CLIENT_ID=landflow
   LANDFLOW_OIDC_CLIENT_SECRET=<shown once>
   LANDFLOW_OIDC_SCOPES="openid email profile roles"
   LANDFLOW_OIDC_ROLE_MAP="Landflow Editors=member,Landflow Admins=admin"
   LANDFLOW_OIDC_LABEL="Sign in with Landbright"
   ```

   `LANDFLOW_OIDC_SCOPES` matters: Landflow's default (`openid email profile`) doesn't ask for `roles`, so everyone
   would get Landflow's default role.
4. Restart Landflow. "Sign in with Landbright" appears on its sign-in page. A person lands with the highest role any of
   their groups maps to; an existing Landflow account with the same verified email is linked.

Run Landflow on the host (its `pnpm dev`) for this. Inside a container `localhost:4402` is the container itself, and
Landflow takes the token and key URLs from the discovery document, so `LANDFLOW_OIDC_DISCOVERY_URL` alone doesn't help:
the issuer would need an address that both the browser and the container reach (docs/limitations.md).

`e2e/test/signin.test.ts` signs in exactly the way Landflow does (Basic client authentication with `client_id` also in
the body, nonce, PKCE, JWKS verification, `mappedRole`), so a change on either side shows up there.

## Revocation

Deactivating a person deletes every session, grant, authorization code and refresh token they hold at the identity
plane, so introspection reports their access tokens inactive at once and refresh fails. Applications that only check
the ID token at sign-in keep their own session until it ends; pushing the change to them (SCIM, back-channel logout) is
wave 2. Deleting an application revokes its tokens the same way. Rotating its secret makes the old secret fail at once.

## Keys and secrets

- Signing keys are RSA 2048 (RS256). The first is generated on first start under an advisory lock (so two replicas
  don't both make one) and stored in `signing_key` with the private half sealed with AES-256-GCM under a key derived
  from `LANDBRIGHT_SECRET_KEY`.
- **Rotation** (Settings → Signing keys → *Rotate*, or `POST /api/settings/signing-keys/rotate`): a new key signs ID
  tokens from then on, the key it replaces stays in the JWKS so the tokens it signed still verify, and any older key is
  retired. So at most two keys are published, the signing one and the verifying one. A rotation that would retire a key
  whose ID tokens could still be alive is refused (409) until they have expired, which is `LANDBRIGHT_ID_TOKEN_TTL_SECONDS`
  (an hour) after the current key took over; Settings shows when. Nobody is signed out, and access and refresh tokens
  are opaque, so they don't depend on the keys. Relying parties pick up the new key from the JWKS when they meet an
  unknown `kid` (Landflow's `openid-client` refetches it).
- The identity plane builds its OIDC provider with the published keys and rebuilds it when they change: while requests
  come in it compares the set at most every five seconds (one small query), so every replica follows a rotation within
  seconds without a message bus.
- Client secrets are not stored: each is an HMAC of `clientId:version` under another derived key. The console shows a
  secret on registration and rotation only.
- Cookie keys for the identity plane are derived from the same secret. Changing `LANDBRIGHT_SECRET_KEY` therefore ends
  every session, changes every client secret and makes the stored signing keys unreadable (a new one is generated;
  rotate to retire the unreadable ones from the JWKS).
