import {
  ApplicationWithSecret,
  AuditPage,
  GroupDetail,
  Me,
  Person,
  RotationResult,
  Settings,
} from '@landbright/contracts';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CreationOptions, passkeyForm, type RequestOptions, SoftAuthenticator } from './authenticator';
import { Browser, formAction } from './browser';
import { LandflowLikeRp } from './landflow-rp';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

/**
 * Wave 1's first slice, end to end: an administrator signs in to the console, creates a group, registers Landflow
 * and adds a person; the person sets a password from the invite email, signs in to Landflow over OIDC and lands with
 * the role their group maps to. Then deactivating them ends their sign-ins and tokens.
 */
/** ID tokens live this long here, so the signing keys can rotate twice in one run (see 'signing keys'). */
const TTL = 15;

describe.skipIf(!e2eEnabled)('sign-in end to end', () => {
  let stack: Stack;
  const admin = new Browser();
  const host = '127.0.0.1';
  let api: (path: string, init?: RequestInit) => Promise<Response>;
  let editors: GroupDetail;
  let landflow: ApplicationWithSecret;
  let maya: Person;
  const mayaPassword = 'maya-correct-horse-battery';
  let rp: LandflowLikeRp;
  let accessToken: string;

  /**
   * Signs in through the identity plane's pages; returns the redirect back to the app (not followed). After the
   * password, an optional offer to set up an authenticator app is declined unless `second` handles the page.
   */
  async function signIn(
    browser: Browser,
    startUrl: string,
    email: string,
    password: string,
    back: (u: URL) => boolean,
    second?: (page: { html: string; url: string }) => Promise<{ response: Response; url: string }>,
  ) {
    const page = await browser.navigate(startUrl, {}, back);
    if (back(new URL(page.url))) return page; // already signed in at the identity plane
    expect(page.response.status).toBe(200);
    const html = await page.response.text();
    const after = await browser.submit(page.url, formAction(html), { email, password }, back);
    if (back(new URL(after.url)) || after.response.status !== 200) return after;
    const next = await after.response.text();
    if (second && /\/totp|\/passkey\/(verify|enroll)/.test(next)) return second({ html: next, url: after.url });
    const skip = /action="([^"]+\/totp\/skip)"/.exec(next)?.[1];
    if (skip) return browser.submit(after.url, skip, {}, back);
    return { response: new Response(next, { status: 200 }), url: after.url };
  }

  /** The newest invite link mailed to `email` (Mailpit). */
  async function inviteLink(email: string): Promise<string> {
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    ).json()) as { messages: Array<{ ID: string }> };
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`)).json()) as {
      Text: string;
    };
    return /http:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(message.Text)![0];
  }

  const codeFor = (secret: string, offsetMs = 0) =>
    new TOTP({ secret: Secret.fromBase32(secret.replace(/\s+/g, '')) }).generate({ timestamp: Date.now() + offsetMs });

  beforeAll(async () => {
    stack = await startStack({ idTokenTtlSeconds: TTL });
    api = (path, init = {}) =>
      admin.fetch(`${stack.control}${path}`, {
        ...init,
        headers: {
          origin: stack.control,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers as Record<string, string>),
        },
      });
  });
  afterAll(() => stack?.stop());

  it('keeps the console API closed without a session', async () => {
    expect((await fetch(`${stack.control}/api/people`)).status).toBe(401);
    expect((await fetch(`${stack.control}/api/health`)).status).toBe(401);
  });

  it('signs the administrator in to the console over OIDC', async () => {
    const backToConsole = (u: URL) => u.origin === stack.control && u.pathname === '/people';
    const landed = await signIn(
      admin,
      `${stack.control}/api/auth/login?returnTo=/people`,
      stack.admin.email,
      stack.admin.password,
      backToConsole,
    );
    expect(landed.url).toBe(`${stack.control}/people`);
    expect(admin.cookie(host, 'lb_session')).toBeTruthy();
    const me = Me.parse(await (await api('/api/auth/me')).json());
    expect(me).toMatchObject({ email: stack.admin.email, admin: true, tenant: { slug: stack.slug } });
  });

  it('refuses a returnTo that leaves the console', async () => {
    const response = await admin.fetch(`${stack.control}/api/auth/login?returnTo=//evil.test/`);
    expect(response.status).toBe(302);
    // The state stored with this sign-in says "/", whatever was asked.
  });

  it('creates a group and registers Landflow', async () => {
    const group = await api('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'Landflow Editors', description: 'Edit Landflow workflows' }),
    });
    expect(group.status).toBe(201);
    editors = GroupDetail.parse(await group.json());

    const app = await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Landflow (e2e)',
        clientId: `landflow-${stack.slug}`,
        redirectUris: ['http://127.0.0.1:3000/api/auth/oidc/callback'],
      }),
    });
    expect(app.status).toBe(201);
    landflow = ApplicationWithSecret.parse(await app.json());
    expect(landflow.issuer).toBe(stack.issuer);
    expect(landflow.clientSecret.length).toBeGreaterThan(30);
  });

  it('adds a person in that group and emails them an invite', async () => {
    const response = await api('/api/people', {
      method: 'POST',
      body: JSON.stringify({
        email: `Maya@${stack.slug}.test`,
        givenName: 'Maya',
        familyName: 'Cohen',
        department: 'Engineering',
        groupIds: [editors.id],
      }),
    });
    expect(response.status).toBe(201);
    maya = Person.parse(await response.json());
    expect(maya).toMatchObject({
      email: `maya@${stack.slug}.test`,
      displayName: 'Maya Cohen',
      hasPassword: false,
      groups: [{ name: 'Landflow Editors' }],
    });

    const duplicate = await api('/api/people', {
      method: 'POST',
      body: JSON.stringify({ email: maya.email, givenName: 'Maya', sendInvite: false }),
    });
    expect(duplicate.status).toBe(409);
  });

  it('lets the person set a password from the email', async () => {
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${maya.email}"`)}`)
    ).json()) as { messages: Array<{ ID: string }> };
    expect(search.messages.length).toBe(1);
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`)).json()) as {
      Text: string;
      Subject: string;
    };
    expect(message.Subject).toBe('Set your Landbright password');
    const link = /http:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(message.Text)?.[0];
    expect(link?.startsWith(stack.idp)).toBe(true);

    const browser = new Browser();
    const page = await browser.navigate(link!);
    expect(page.response.status).toBe(200);
    const done = await browser.submit(page.url, formAction(await page.response.text()), {
      password: mayaPassword,
      confirm: mayaPassword,
    });
    expect(await done.response.text()).toContain('Your password is set');
    // The link works once.
    expect((await browser.navigate(link!)).response.status).toBe(404);
    expect(Person.parse(await (await api(`/api/people/${maya.id}`)).json()).hasPassword).toBe(true);
  });

  it('signs the person in to Landflow with the role their group maps to', async () => {
    rp = new LandflowLikeRp({
      issuer: stack.issuer,
      clientId: landflow.application.clientId,
      clientSecret: landflow.clientSecret,
      redirectUri: 'http://127.0.0.1:3000/api/auth/oidc/callback',
      scopes: 'openid email profile roles',
      roleMap: { 'Landflow Editors': 'member', 'Landflow Admins': 'admin' },
    });
    const browser = new Browser();
    const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');
    const landed = await signIn(browser, await rp.authorizationUrl(), maya.email!, mayaPassword, back);
    const result = await rp.complete(landed.url);
    expect(result.claims).toMatchObject({
      sub: maya.id,
      email: maya.email,
      email_verified: true,
      name: 'Maya Cohen',
      roles: ['Landflow Editors'],
    });
    expect(result.role).toBe('member');
    accessToken = result.accessToken;
  });

  it('refuses a wrong password, a wrong secret and a wrong redirect', async () => {
    const browser = new Browser();
    const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');
    const page = await signIn(browser, await rp.authorizationUrl(), maya.email!, 'not-her-password', back);
    expect(await page.response.text()).toContain('don’t match');

    const wrong = new LandflowLikeRp({ ...rp.config, clientSecret: 'nope' });
    const attempt = await signIn(new Browser(), await wrong.authorizationUrl(), maya.email!, mayaPassword, back);
    await expect(wrong.complete(attempt.url)).rejects.toThrow(/invalid_client/);

    const elsewhere = new LandflowLikeRp({ ...rp.config, redirectUri: 'http://127.0.0.1:3000/elsewhere' });
    const refused = await new Browser().navigate(await elsewhere.authorizationUrl());
    expect(refused.response.status).toBe(400);
  });

  it('deactivating the person ends their sign-in and revokes their tokens', async () => {
    const introspect = async () => {
      const basic = Buffer.from(`${landflow.application.clientId}:${landflow.clientSecret}`).toString('base64');
      const response = await fetch(`${stack.issuer}/token/introspection`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
        body: new URLSearchParams({ token: accessToken }),
      });
      return ((await response.json()) as { active: boolean }).active;
    };
    expect(await introspect()).toBe(true);
    const response = await api(`/api/people/${maya.id}/deactivate`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(Person.parse(await response.json()).status).toBe('deactivated');
    expect(await introspect()).toBe(false);

    const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');
    const page = await signIn(new Browser(), await rp.authorizationUrl(), maya.email!, mayaPassword, back);
    expect(await page.response.text()).toContain('don’t match');
  });

  it('guards the last administrator and the console client', async () => {
    const groups = (await (await api('/api/groups')).json()) as {
      items: Array<{ id: string; name: string; system: boolean }>;
    };
    const admins = groups.items.find((g) => g.system)!;
    const me = Me.parse(await (await api('/api/auth/me')).json());
    expect((await api(`/api/groups/${admins.id}/members/${me.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await api(`/api/groups/${admins.id}`, { method: 'DELETE' })).status).toBe(403);
    const apps = (await (await api('/api/applications')).json()) as { items: Array<{ id: string; system: boolean }> };
    expect(
      (await api(`/api/applications/${apps.items.find((a) => a.system)!.id}/rotate-secret`, { method: 'POST' })).status,
    ).toBe(403);
  });

  describe('a second step', () => {
    let noa: Person;
    let secret = '';
    let enrolledCode = '';
    const noaPassword = 'noa-correct-horse-battery';
    const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');

    it('is required for everyone once Settings says so', async () => {
      const settings = await api('/api/settings/sign-in', {
        method: 'PATCH',
        body: JSON.stringify({ mfaRequired: true }),
      });
      expect(settings.status).toBe(200);
      expect(((await settings.json()) as { signIn: { mfaRequired: boolean } }).signIn.mfaRequired).toBe(true);

      const created = await api('/api/people', {
        method: 'POST',
        body: JSON.stringify({
          email: `noa@${stack.slug}.test`,
          givenName: 'Noa',
          familyName: 'Levi',
          groupIds: [editors.id],
        }),
      });
      noa = Person.parse(await created.json());
      const browser = new Browser();
      const link = await inviteLink(noa.email!);
      const page = await browser.navigate(link);
      await browser.submit(page.url, formAction(await page.response.text()), {
        password: noaPassword,
        confirm: noaPassword,
      });
    });

    it('is set up at sign-in, with no way to skip it, and the token says so', async () => {
      const browser = new Browser();
      const landed = await signIn(
        browser,
        await rp.authorizationUrl(),
        noa.email!,
        noaPassword,
        back,
        async ({ html, url }) => {
          expect(html).toContain('Add a second step');
          expect(html).not.toContain('Not now');
          expect(html).toContain('data:image/png;base64,');
          secret = /data-secret>([A-Z2-7 ]+)</.exec(html)![1]!;
          const wrong = await browser.submit(url, formAction(html), { code: '000000' }, back);
          expect(await wrong.response.text()).toContain('didn’t match');
          enrolledCode = codeFor(secret);
          return browser.submit(url, formAction(html), { code: enrolledCode }, back);
        },
      );
      const result = await rp.complete(landed.url);
      expect(result.claims).toMatchObject({
        email: noa.email,
        roles: ['Landflow Editors'],
        amr: ['pwd', 'otp', 'mfa'],
      });
      expect(Person.parse(await (await api(`/api/people/${noa.id}`)).json()).hasTotp).toBe(true);
    });

    it('asks for a code next time, and a code works once', async () => {
      const browser = new Browser();
      const landed = await signIn(
        browser,
        await rp.authorizationUrl(),
        noa.email!,
        noaPassword,
        back,
        async ({ html, url }) => {
          expect(html).toContain('Enter your code');
          const replay = await browser.submit(url, formAction(html), { code: enrolledCode }, back);
          expect(await replay.response.text()).toContain('each works once');
          // The next 30-second step's code is within the allowed drift, and newer than the one used.
          return browser.submit(url, formAction(html), { code: codeFor(secret, 30_000) }, back);
        },
      );
      expect((await rp.complete(landed.url)).claims.amr).toEqual(['pwd', 'otp', 'mfa']);
    });

    it('can be reset by an administrator, and is set up again at the next sign-in', async () => {
      const reset = await api(`/api/people/${noa.id}/reset-second-step`, { method: 'POST' });
      expect(Person.parse(await reset.json()).hasTotp).toBe(false);
      const browser = new Browser();
      let offered = '';
      await signIn(browser, await rp.authorizationUrl(), noa.email!, noaPassword, back, async ({ html, url }) => {
        offered = html;
        return { response: new Response(html), url };
      });
      expect(offered).toContain('Add a second step');
      await api('/api/settings/sign-in', { method: 'PATCH', body: JSON.stringify({ mfaRequired: false }) });
    });
  });

  describe('passkeys', () => {
    let lior: Person;
    const liorPassword = 'lior-correct-horse-battery';
    const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');
    let authenticator: SoftAuthenticator;

    /** The sign-in page for a new authorization request, in a fresh browser. */
    async function signInPage() {
      const browser = new Browser();
      const page = await browser.navigate(await rp.authorizationUrl());
      return { browser, url: page.url, html: await page.response.text() };
    }

    it('are on, because the issuer is a domain', async () => {
      authenticator = new SoftAuthenticator(stack.idp);
      const settings = (await (await api('/api/settings')).json()) as { signIn: { methods: string[] } };
      expect(settings.signIn.methods).toContain('passkey');
      const created = await api('/api/people', {
        method: 'POST',
        body: JSON.stringify({
          email: `lior@${stack.slug}.test`,
          givenName: 'Lior',
          familyName: 'Ben-David',
          groupIds: [editors.id],
        }),
      });
      lior = Person.parse(await created.json());
      const browser = new Browser();
      const page = await browser.navigate(await inviteLink(lior.email!));
      await browser.submit(page.url, formAction(await page.response.text()), {
        password: liorPassword,
        confirm: liorPassword,
      });
    });

    it('are offered next to the authenticator app, and adding one finishes the sign-in', async () => {
      const browser = new Browser();
      const landed = await signIn(
        browser,
        await rp.authorizationUrl(),
        lior.email!,
        liorPassword,
        back,
        async ({ html, url }) => {
          expect(html).toContain('Add a second step');
          const form = passkeyForm<CreationOptions>(html, 'create')!;
          expect(form.options.rp.id).toBe('localhost');
          expect(form.options.authenticatorSelection).toMatchObject({
            residentKey: 'required',
            userVerification: 'required',
          });
          expect(Buffer.from(form.options.user.id, 'base64url').toString()).toBe(lior.id);
          return browser.submit(
            url,
            form.action,
            { response: JSON.stringify(authenticator.create(form.options)) },
            back,
          );
        },
      );
      const result = await rp.complete(landed.url);
      expect(result.claims).toMatchObject({ email: lior.email, amr: ['pwd', 'pop', 'mfa'] });
      expect(Person.parse(await (await api(`/api/people/${lior.id}`)).json()).passkeys).toBe(1);
    });

    it('sign in alone, without a password, with the role the group maps to', async () => {
      const { browser, url, html } = await signInPage();
      const form = passkeyForm<RequestOptions>(html, 'get')!;
      expect(form.options.allowCredentials ?? []).toEqual([]); // discoverable: no email needed first
      expect(form.options.userVerification).toBe('required');
      const landed = await browser.submit(
        url,
        form.action,
        { response: JSON.stringify(authenticator.get(form.options)) },
        back,
      );
      const result = await rp.complete(landed.url);
      expect(result.claims).toMatchObject({ email: lior.email, roles: ['Landflow Editors'], amr: ['pop', 'mfa'] });
      expect(result.role).toBe('member');
    });

    it('refuse another origin, a used challenge and a missing user verification', async () => {
      const { browser, url, html } = await signInPage();
      const first = passkeyForm<RequestOptions>(html, 'get')!;
      const elsewhere = authenticator.get(first.options, { origin: 'http://127.0.0.1:3000' });
      const refused = await browser.submit(url, first.action, { response: JSON.stringify(elsewhere) }, back);
      const again = await refused.response.text();
      expect(again).toContain('That passkey didn’t work');
      // The first challenge was taken by that attempt: a good response to it no longer works.
      const stale = await browser.submit(
        url,
        first.action,
        { response: JSON.stringify(authenticator.get(first.options)) },
        back,
      );
      expect(await stale.response.text()).toContain('That passkey didn’t work');
      const { browser: b2, url: u2, html: h2 } = await signInPage();
      const fresh = passkeyForm<RequestOptions>(h2, 'get')!;
      const unverified = authenticator.get(fresh.options, { userVerified: false });
      expect(
        await (await b2.submit(u2, fresh.action, { response: JSON.stringify(unverified) }, back)).response.text(),
      ).toContain('That passkey didn’t work');
    });

    it('are the second step after a password, for someone who has one', async () => {
      const browser = new Browser();
      const landed = await signIn(
        browser,
        await rp.authorizationUrl(),
        lior.email!,
        liorPassword,
        back,
        async ({ html, url }) => {
          expect(html).toContain('Use your passkey');
          expect(html).not.toContain('one-time-code');
          const form = passkeyForm<RequestOptions>(html, 'get')!;
          expect(form.options.allowCredentials?.length).toBe(1);
          return browser.submit(url, form.action, { response: JSON.stringify(authenticator.get(form.options)) }, back);
        },
      );
      expect((await rp.complete(landed.url)).claims.amr).toEqual(['pwd', 'pop', 'mfa']);
    });

    it('stop working when an administrator resets the second step', async () => {
      const reset = await api(`/api/people/${lior.id}/reset-second-step`, { method: 'POST' });
      expect(Person.parse(await reset.json()).passkeys).toBe(0);
      const { browser, url, html } = await signInPage();
      const form = passkeyForm<RequestOptions>(html, 'get')!;
      const refused = await browser.submit(
        url,
        form.action,
        { response: JSON.stringify(authenticator.get(form.options)) },
        back,
      );
      expect(await refused.response.text()).toContain('That passkey didn’t work');
    });
  });

  describe('signing keys', () => {
    const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');
    const kidOf = (jwt: string) =>
      (JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString()) as { kid: string }).kid;
    /** An ID token for the administrator (still signed in at the identity plane from the console). */
    async function idToken() {
      const landed = await signIn(admin, await rp.authorizationUrl(), stack.admin.email, stack.admin.password, back);
      return rp.complete(landed.url);
    }
    const jwks = async () =>
      ((await (await fetch(`${stack.issuer}/jwks`)).json()) as { keys: Array<{ kid: string }> }).keys.map((k) => k.kid);
    /** The identity plane checks the key set at most every five seconds. */
    async function jwksBecomes(expected: string[]) {
      for (let i = 0; i < 40 && (await jwks()).join() !== expected.join(); i++)
        await new Promise((r) => setTimeout(r, 250));
      expect(await jwks()).toEqual(expected);
    }
    const settings = async () => Settings.parse(await (await api('/api/settings')).json());
    const rotate = () => api('/api/settings/signing-keys/rotate', { method: 'POST' });
    let first: { kid: string; idToken: string; nonce: string };
    let second: string;

    it('rotate: a new key signs, and the replaced key still verifies its tokens', async () => {
      const before = await settings();
      const signing = before.signingKeys.find((k) => k.status === 'signing')!;
      expect(before.rotateAfter).toBeNull();
      const t1 = await idToken();
      expect(kidOf(t1.idToken)).toBe(signing.kid);
      first = { kid: signing.kid, idToken: t1.idToken, nonce: String(t1.claims.nonce) };

      const response = await rotate();
      expect(response.status).toBe(200);
      const result = RotationResult.parse(await response.json());
      second = result.kid;
      // Whatever an earlier run left published besides the signing key is retired now.
      expect(result.retired).not.toContain(signing.kid);
      expect(result.settings.signingKeys.filter((k) => k.status !== 'retired').map((k) => [k.kid, k.status])).toEqual([
        [second, 'signing'],
        [signing.kid, 'verifying'],
      ]);

      await jwksBecomes([second, signing.kid]);
      // A token signed before the rotation still verifies, the way Landflow checks it.
      const { jwks_uri } = await rp.discovery();
      await expect(rp.verifyIdToken(first.idToken, jwks_uri, first.nonce)).resolves.toMatchObject({
        email: stack.admin.email,
      });
      const t2 = await idToken();
      expect(kidOf(t2.idToken)).toBe(second);
    });

    it('waits before the next rotation, while the replaced key may still have live tokens', async () => {
      const response = await rotate();
      expect(response.status).toBe(409);
      expect(((await response.json()) as { message: string }).message).toContain('still verifies ID tokens until');
      const s = await settings();
      expect(new Date(s.rotateAfter!).getTime()).toBeGreaterThan(Date.now());
    });

    it(
      'retires the oldest key at the next rotation, once its tokens have expired',
      async () => {
        const { rotateAfter } = await settings();
        await new Promise((r) => setTimeout(r, Math.max(0, new Date(rotateAfter!).getTime() - Date.now()) + 200));
        const response = await rotate();
        expect(response.status).toBe(200);
        const result = RotationResult.parse(await response.json());
        expect(result.retired).toEqual([first.kid]);
        await jwksBecomes([result.kid, second]);
        expect(kidOf((await idToken()).idToken)).toBe(result.kid);
      },
      TTL * 1000 + 20_000,
    );
  });

  it('refuses writes from another origin', async () => {
    const response = await admin.fetch(`${stack.control}/api/groups`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sneaky' }),
    });
    expect(response.status).toBe(403);
  });

  it('records all of it in an intact, hash-chained audit log', async () => {
    const page = AuditPage.parse(await (await api('/api/audit?limit=200')).json());
    expect(page.chainIntact).toBe(true);
    const actions = page.items.map((e) => e.action);
    for (const action of [
      'identity.created',
      'group.created',
      'client.created',
      'identity.invited',
      'credential.password_set',
      'credential.passkey_added',
      'signing_key.rotated',
      'session.signed_in',
      'session.sign_in_failed',
      'console.signed_in',
      'identity.deactivated',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('signs the administrator out of the console and the identity plane', async () => {
    const response = await api('/api/auth/logout', { method: 'POST' });
    const { redirect } = (await response.json()) as { redirect: string };
    expect(redirect.startsWith(`${stack.issuer}/session/end`)).toBe(true);
    expect((await api('/api/auth/me')).status).toBe(401);
  });
});
