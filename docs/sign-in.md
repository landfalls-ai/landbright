# Sign-in

Landbright is an OpenID Connect provider. Applications (Landflow, Landfall, Landbright's own console) send people to
it to sign in and get back an ID token that says who they are and which groups they are in.

## The issuer

`http://127.0.0.1:4402/oidc` locally (`<LANDBRIGHT_IDP_URL>/oidc`). Discovery is at
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
| `openid` | `sub`: the identity's id |
| `email` | `email`, `email_verified` (true: an administrator or an HR source entered it) |
| `profile` | `name`, `given_name`, `family_name`, `preferred_username` (the email) |
| `roles` | `roles` and `groups`: the names of the person's groups, sorted; expired just-in-time memberships left out |

Only active people can sign in. There is no consent screen: an application exists only because an administrator
registered it, so it gets the scopes it asks for.

## Signing in

The pages are server-rendered by the identity plane, in Landflow's tokens, with no JavaScript and a CSP of
`default-src 'none'` (`apps/idp/src/pages`). Wave 1 signs in with email and password; passkeys and TOTP come next.

- A wrong email and a wrong password get the same answer, and take the same time (a decoy argon2 hash).
- Ten failures for one email in 15 minutes lock that email for the rest of the window. The counter lives in Valkey;
  if Valkey is down, sign-in still works without it.
- Every success and failure is in the audit log (`session.signed_in`, `session.sign_in_failed`).

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
   LANDFLOW_OIDC_ISSUER=http://127.0.0.1:4402/oidc
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

Run Landflow on the host (its `pnpm dev`) for this. Inside a container `127.0.0.1:4402` is the container itself, and
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

- The signing key is RSA 2048, generated on first start under an advisory lock (so two replicas don't both make one)
  and stored in `signing_key` with the private half sealed with AES-256-GCM under a key derived from
  `LANDBRIGHT_SECRET_KEY`.
- Client secrets are not stored: each is an HMAC of `clientId:version` under another derived key. The console shows a
  secret on registration and rotation only.
- Cookie keys for the identity plane are derived from the same secret. Changing `LANDBRIGHT_SECRET_KEY` therefore ends
  every session, changes every client secret and makes the stored signing key unreadable (a new one is generated).
