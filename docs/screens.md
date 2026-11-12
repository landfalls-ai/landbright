# Screens

Every screen of wave 1, captured in real Chromium by the Playwright story in
[`e2e/browser/console.spec.ts`](../e2e/browser/console.spec.ts) against the built services and a throwaway test tenant.
Run `pnpm screenshots` to capture them again (see [development.md](development.md)). Everyone in them is fictitious.

## Signing in

**The sign-in page (here for the console). A passkey needs no email.**

![The sign-in page (here for the console). A passkey needs no email.](screenshots/01-sign-in.png)

**After the password: an authenticator app, a passkey instead, or *Not now*.**

![After the password: an authenticator app, a passkey instead, or *Not now*.](screenshots/02-second-step-offer.png)

**The invite email (Mailpit).**

![The invite email (Mailpit).](screenshots/13a-invite-email.png)

**Setting a password from the invite.**

![Setting a password from the invite.](screenshots/13-invite.png)

**Password set.**

![Password set.](screenshots/14-password-set.png)

**The second step for someone with a passkey.**

![The second step for someone with a passkey.](screenshots/17-second-step-passkey.png)

**The second step for someone with an authenticator app.**

![The second step for someone with an authenticator app.](screenshots/18-second-step-code.png)

**Signing out at the identity plane.**

![Signing out at the identity plane.](screenshots/25-sign-out.png)

## Arriving in an app

**A Landflow-shaped test app after the callback: password, then a new passkey (`amr` pwd, pop, mfa).**

![A Landflow-shaped test app after the callback: password, then a new passkey (`amr` pwd, pop, mfa).](screenshots/15-landflow-after-passkey-added.png)

**The passkey alone (`amr` pop, mfa).**

![The passkey alone (`amr` pop, mfa).](screenshots/16-landflow-passkey-only.png)

**Password and an authenticator code (`amr` pwd, otp, mfa).**

![Password and an authenticator code (`amr` pwd, otp, mfa).](screenshots/19-landflow-after-code.png)

## The console

**Home.**

![Home.](screenshots/03-console-home.png)

**People.**

![People.](screenshots/06-people.png)

**Adding a person.**

![Adding a person.](screenshots/05-add-person.png)

**A person with a password and a passkey.**

![A person with a password and a passkey.](screenshots/20-person.png)

**Agents and their sponsors.**

![Agents and their sponsors.](screenshots/07-agents.png)

**Groups.**

![Groups.](screenshots/08-groups.png)

**Creating a group.**

![Creating a group.](screenshots/04-new-group.png)

**A group.**

![A group.](screenshots/09-group.png)

**Applications.**

![Applications.](screenshots/12-applications.png)

**Registering Landflow.**

![Registering Landflow.](screenshots/10-register-application.png)

**The client secret, shown once (covered in the picture).**

![The client secret, shown once (covered in the picture).](screenshots/11-application-secret.png)

**The audit log, chain intact.**

![The audit log, chain intact.](screenshots/21-audit.png)

**Settings: require a second step, the sign-in methods, and the signing keys (one signing, one verifying) with Rotate.**

![Settings: require a second step, the sign-in methods, and the signing keys (one signing, one verifying) with Rotate.](screenshots/22-settings.png)

**Health.**

![Health.](screenshots/23-health.png)

**A page of a later wave.**

![A page of a later wave.](screenshots/24-upcoming-requests.png)

**The dark theme.**

![The dark theme.](screenshots/26-people-dark.png)
