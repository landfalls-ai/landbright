# Directory

The console's Directory and Connect pages: people, agents, groups, applications, and the audit log behind them. All of
it is for administrators (members of *Landbright Admins*).

## People

A person has an email (unique, lowercased), a name, and HR attributes: department, title, site, manager, start and end
dates. Wave 3 fills these from HiBob and Shapes; until then administrators add people in the console.

- **Add person** creates them active, in the chosen groups, and by default emails an invite to set a password
  ([sign-in.md](sign-in.md#passwords)). The list shows *Invited* until they do.
- **Send the invite again** issues a new link and cancels the old one; for someone with a password it is a reset.
- **Deactivate** blocks sign-in, revokes every session and token at once, cancels open invites and suspends the agents
  they sponsor. It also ends their grants and cancels their waiting requests, and their agents' ([access.md](access.md)).
  A lifecycle flow can do the same through `POST /api/v1/people/:id/deactivate`. Each sign-in records
  `lastSignInAt`, which the *Disable inactive people* flow reads. **Reactivate** undoes the first; agents stay suspended until resumed. You can't deactivate yourself or
  the last active administrator.
- **Sign-in** shows how they sign in: password, authenticator app, passkeys. **Reset** (when they have an app or a
  passkey) deletes both, for a lost phone or laptop; they set up a new second step at their next sign-in
  ([sign-in.md](sign-in.md#the-second-step)).

## Agents

An agent identity has a **sponsor** (an active person who answers for it), a purpose, a runtime (Landflow, kagent,
Claude Code, external), an optional home project, a risk tier, whom it may act for, and the longest token it may hold
(1 to 60 minutes, 15 by default). Agents can be in groups but not in *Landbright Admins*. Suspending one is immediate.

An agent gets tokens through its own application (*Connect* on its row: its public keys, `private_key_jwt`), and acts
for a person only with that person's say-so: token exchange, CIBA or the device grant ([agents.md](agents.md)).
Landflow sync is still wave 5.

## Groups

Groups are what applications see: their names travel in the `roles` and `groups` claims, so Landflow's role map refers
to them. A name can't contain `,` or `=`. Renaming a group changes what every application sees at the next sign-in.

Kinds: *static* (managed here), *birthright* (given by HR rules, wave 3) and *just in time* (time-boxed grants, wave
4). *Landbright Admins* can't be renamed or deleted and always keeps one active person.

## Applications

The OIDC clients that sign in with Landbright. Registering one shows its client secret once, with the settings to paste
into Landflow ([sign-in.md](sign-in.md#connecting-landflow)). **New secret** rotates it (the old one stops at once);
**Delete** revokes its tokens. The console's own client is shown but can't be changed here.

## Settings

The tenant (name, slug, issuer), sign-in (**Require a second step for everyone**, and the methods there are: passkeys
appear when the issuer is a domain), and the
signing keys published at `/oidc/jwks`. Key rotation comes later in wave 1.

## Audit log

Every change is an event: who (actor), what (`identity.created`, `group.member_added`, `client.secret_rotated`,
`session.signed_in`, …), the target, and details. Events are written in the same transaction as the change, can't be
updated or deleted (a database trigger refuses), and each one's hash covers the previous one's, per tenant. The page
checks the events it shows (and the one before them) and says *Chain intact* or *Chain broken*.

## How the data is kept

Every tenant table has `tenant_id` and forced row-level security. The services connect as `landbright_app`, which
isn't a superuser, and every query runs inside `withTenant`, which sets `app.tenant_id` for one transaction; outside
it, the tables look empty. `libs/persistence/prisma/schema.prisma` describes each table.
