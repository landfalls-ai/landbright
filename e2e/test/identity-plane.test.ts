import { ApplicationWithSecret, GroupDetail, GroupList, Person } from '@landbright/contracts';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { LandflowLikeRp } from './landflow-rp';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

/**
 * Spec 005, slice 2, the identity plane end to end: forgot password, required actions (set by an administrator and by
 * a flow, with and without the email), how strongly someone signed in (`acr`) and an application's minimum (step-up),
 * recovery codes, the account page, and the machine API for people and groups.
 */
describe.skipIf(!e2eEnabled)('the identity plane end to end', () => {
  let stack: Stack;
  const admin = new Browser();
  const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');
  let plain: LandflowLikeRp;
  let strong: LandflowLikeRp;
  let strongApp: ApplicationWithSecret;
  let flowToken: string;
  const people: Record<string, Person> = {};
  const passwords: Record<string, string> = {};
  let danaSecret = '';
  let codes: string[] = [];

  const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) });
  const api = (path: string, init: RequestInit = {}) =>
    admin.fetch(`${stack.control}${path}`, {
      ...init,
      headers: {
        origin: stack.control,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  const machine = (path: string, init: RequestInit = {}) =>
    fetch(`${stack.control}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${flowToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  const codeFor = (secret: string, offsetMs = 0) =>
    new TOTP({ secret: Secret.fromBase32(secret.replace(/\s+/g, '')) }).generate({ timestamp: Date.now() + offsetMs });

  async function expectStatus(response: Response, status: number) {
    if (response.status !== status) expect(`${response.status} ${await response.clone().text()}`).toBe(String(status));
  }

  /** The newest mail to `email` whose subject contains `subject`, once it arrives. */
  async function mail(email: string, subject: string, after = 0): Promise<{ Text: string; Subject: string }> {
    for (let i = 0; i < 40; i++) {
      const search = (await (
        await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}" subject:"${subject}"`)}`)
      ).json()) as { messages: Array<{ ID: string; Created: string }> };
      const found = search.messages.find((m) => Date.parse(m.Created) >= after);
      if (found) return (await (await fetch(`${MAILPIT}/api/v1/message/${found.ID}`)).json()) as never;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`no "${subject}" mail to ${email}`);
  }

  async function addPerson(givenName: string): Promise<Person> {
    const email = `${givenName.toLowerCase()}@${stack.slug}.test`;
    const created = await api('/api/people', json({ email, givenName, familyName: 'Test' }));
    await expectStatus(created, 201);
    const person = Person.parse(await created.json());
    const link = /http:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec((await mail(email, 'Set your')).Text)![0];
    const browser = new Browser();
    const page = await browser.navigate(link);
    passwords[givenName] = `${givenName}-correct-horse-battery`;
    await browser.submit(page.url, formAction(await page.response.text()), {
      password: passwords[givenName],
      confirm: passwords[givenName],
    });
    people[givenName] = person;
    return person;
  }

  /** The password page of a new sign-in to `rp`, in `browser`; returns the page after the password. */
  async function password(browser: Browser, rp: LandflowLikeRp, name: string, extra: Record<string, string> = {}) {
    const page = await browser.navigate(await rp.authorizationUrl(extra), {}, back);
    if (back(new URL(page.url))) return { ...page, html: '' };
    const html = await page.response.text();
    const after = await browser.submit(
      page.url,
      formAction(html),
      { email: people[name]!.email!, password: passwords[name]! },
      back,
    );
    return { ...after, html: back(new URL(after.url)) ? '' : await after.response.text(), loginPage: html };
  }

  const actionOf = (html: string, path: RegExp) => {
    const m = new RegExp(`action="([^"]*${path.source}[^"]*)"`).exec(html);
    if (!m) throw new Error(`no ${path} form in:\n${html.slice(0, 600)}`);
    return m[1]!.replace(/&amp;/g, '&');
  };

  beforeAll(async () => {
    stack = await startStack();
    const consoleBack = (u: URL) => u.origin === stack.control && u.pathname === '/people';
    const page = await admin.navigate(`${stack.control}/api/auth/login?returnTo=/people`, {}, consoleBack);
    const after = await admin.submit(
      page.url,
      formAction(await page.response.text()),
      { email: stack.admin.email, password: stack.admin.password },
      consoleBack,
    );
    if (!consoleBack(new URL(after.url))) {
      const skip = /action="([^"]+\/totp\/skip)"/.exec(await after.response.text())![1]!;
      await admin.submit(after.url, skip, {}, consoleBack);
    }
  }, 180_000);
  afterAll(() => stack?.stop());

  it('sets up: two applications (one asks for a second step), a flow, and people', async () => {
    const register = async (name: string, clientId: string, extra: Record<string, unknown> = {}) => {
      const created = await api(
        '/api/applications',
        json({ name, clientId, redirectUris: ['http://127.0.0.1:3000/callback'], ...extra }),
      );
      await expectStatus(created, 201);
      return ApplicationWithSecret.parse(await created.json());
    };
    const rpOf = (app: ApplicationWithSecret) =>
      new LandflowLikeRp({
        issuer: stack.issuer,
        clientId: app.application.clientId,
        clientSecret: app.clientSecret,
        redirectUri: 'http://127.0.0.1:3000/callback',
        scopes: 'openid email profile',
        roleMap: {},
      });
    plain = rpOf(await register('Wiki', `wiki-${stack.slug}`));
    strongApp = await register('Payments console', `payments-${stack.slug}`, { minimumAcr: 'urn:landbright:acr:mfa' });
    expect(strongApp.application.minimumAcr).toBe('urn:landbright:acr:mfa');
    strong = rpOf(strongApp);

    const flow = await register('Onboarding flow', `onboard-${stack.slug}`, {
      grantTypes: ['client_credentials'],
      apiScopes: ['directory:read', 'directory:write'],
    });
    const issued = await fetch(`${stack.issuer}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${flow.application.clientId}:${flow.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'directory:read directory:write' }),
    });
    await expectStatus(issued, 200);
    flowToken = ((await issued.json()) as { access_token: string }).access_token;

    for (const name of ['Dana', 'Eli', 'Fay']) await addPerson(name);
    const discovery = await plain.discovery();
    expect(discovery.acr_values_supported).toEqual([
      'urn:landbright:acr:pwd',
      'urn:landbright:acr:mfa',
      'urn:landbright:acr:phr',
    ]);
  });

  describe('forgot password', () => {
    it('answers the same for anyone, and mails only a real person a one-time link', async () => {
      const browser = new Browser();
      const login = await browser.navigate(await plain.authorizationUrl(), {}, back);
      const forgot = /href="(\/forgot\?uid=[^"]+)"/.exec(await login.response.text())![1]!;
      const form = await browser.navigate(new URL(forgot, login.url).href);
      const page = await form.response.text();
      expect(page).toContain('Forgot your password?');
      const sent = Date.now();
      const known = await browser.submit(form.url, formAction(page), { email: people.Dana!.email! });
      const unknown = await browser.submit(form.url, formAction(page), { email: `nobody@${stack.slug}.test` });
      const [a, b] = [await known.response.text(), await unknown.response.text()];
      expect(a).toContain('Check your email');
      expect(a.replace(people.Dana!.email!, 'X')).toBe(b.replace(`nobody@${stack.slug}.test`, 'X'));

      const message = await mail(people.Dana!.email!, 'Reset your Landbright password', sent - 1000);
      const link = /http:\/\/\S+\/reset\/[A-Za-z0-9_-]+/.exec(message.Text)![0];
      const reset = await browser.navigate(link);
      expect(reset.response.status).toBe(200);
      passwords.Dana = 'Dana-new-horse-battery-staple';
      const done = await browser.submit(reset.url, formAction(await reset.response.text()), {
        password: passwords.Dana,
        confirm: passwords.Dana,
      });
      expect(await done.response.text()).toContain('Your password is changed');
      expect((await browser.navigate(link)).response.status).toBe(404);

      const stranger = new Browser();
      const old = await stranger.navigate(await plain.authorizationUrl(), {}, back);
      const refused = await stranger.submit(old.url, formAction(await old.response.text()), {
        email: people.Dana!.email!,
        password: 'Dana-correct-horse-battery',
      });
      expect(await refused.response.text()).toContain('don’t match');
      const fine = await password(new Browser(), plain, 'Dana');
      expect(fine.html).toContain('Add a second step'); // the password worked; the offer comes next
    });
  });

  describe('required actions', () => {
    it('an administrator asks for a new password and the terms; the person does both before the app', async () => {
      const set = await api(
        `/api/people/${people.Eli!.id}/required-actions`,
        json({ actions: ['update_password', 'accept_terms'] }),
      );
      await expectStatus(set, 200);
      expect(Person.parse(await set.json()).requiredActions).toEqual(['update_password', 'accept_terms']);

      const browser = new Browser();
      let page = await password(browser, plain, 'Eli');
      if (page.html.includes('totp/skip'))
        page = { ...(await browser.submit(page.url, actionOf(page.html, /totp\/skip/), {}, back)), html: '' };
      const html = page.html || (await page.response.text());
      expect(html).toContain('Choose a new password');
      const same = await browser.submit(page.url, formAction(html), {
        password: passwords.Eli!,
        confirm: passwords.Eli!,
      });
      const sameHtml = await same.response.text();
      expect(sameHtml).toContain('haven’t used here');
      passwords.Eli = 'Eli-brand-new-horse-battery';
      const terms = await browser.submit(same.url, formAction(sameHtml), {
        password: passwords.Eli,
        confirm: passwords.Eli,
      });
      const termsHtml = await terms.response.text();
      expect(termsHtml).toContain('accept its terms');
      const unchecked = await browser.submit(terms.url, formAction(termsHtml), {});
      expect(await unchecked.response.text()).toContain('Accept the terms to continue');
      const landed = await browser.submit(terms.url, formAction(termsHtml), { accept: 'yes' }, back);
      expect(back(new URL(landed.url))).toBe(true);
      const { claims } = await plain.complete(landed.url);
      expect(claims.sub).toBe(people.Eli!.id);

      const after = Person.parse(await (await api(`/api/people/${people.Eli!.id}`)).json());
      expect(after.requiredActions).toEqual([]);
      expect(after.termsAcceptedAt).not.toBeNull();
    });

    it('with the email, update_password comes with a link that works without the old password', async () => {
      const sent = Date.now();
      const set = await machine(
        `/api/v1/people/${people.Fay!.id}/required-actions`,
        json({ actions: ['update_password'], notify: true }),
      );
      await expectStatus(set, 200);
      const message = await mail(people.Fay!.email!, 'action needed', sent - 1000);
      expect(message.Text).toContain('choose a new password');
      const link = /http:\/\/\S+\/reset\/[A-Za-z0-9_-]+/.exec(message.Text)![0];
      const browser = new Browser();
      const page = await browser.navigate(link);
      passwords.Fay = 'Fay-fresh-horse-battery-staple';
      await browser.submit(page.url, formAction(await page.response.text()), {
        password: passwords.Fay,
        confirm: passwords.Fay,
      });
      expect(Person.parse(await (await api(`/api/people/${people.Fay!.id}`)).json()).requiredActions).toEqual([]);
    });

    it('configure_second_step makes the second step part of sign-in, with no way to skip it', async () => {
      await expectStatus(
        await api(`/api/people/${people.Dana!.id}/required-actions`, json({ actions: ['configure_second_step'] })),
        200,
      );
      const browser = new Browser();
      const page = await password(browser, plain, 'Dana');
      expect(page.html).toContain('Add a second step');
      expect(page.html).not.toContain('totp/skip');
      danaSecret = /data-secret>([^<]+)</.exec(page.html)![1]!;
      const landed = await browser.submit(
        page.url,
        actionOf(page.html, /totp\/enroll/),
        { code: codeFor(danaSecret) },
        back,
      );
      const { claims } = await plain.complete(landed.url);
      expect(claims.amr).toEqual(['pwd', 'otp', 'mfa']);
      expect(claims.acr).toBe('urn:landbright:acr:mfa');
      expect(Person.parse(await (await api(`/api/people/${people.Dana!.id}`)).json()).requiredActions).toEqual([]);
    });
  });

  describe('how strongly someone signed in (acr)', () => {
    it('a password alone is pwd', async () => {
      const browser = new Browser();
      const page = await password(browser, plain, 'Fay');
      const landed = await browser.submit(page.url, actionOf(page.html, /totp\/skip/), {}, back);
      expect((await plain.complete(landed.url)).claims.acr).toBe('urn:landbright:acr:pwd');

      // Step-up: the same browser, an application that needs a second step. Asked again, and no skipping.
      const again = await browser.navigate(await strong.authorizationUrl(), {}, back);
      expect(back(new URL(again.url))).toBe(false);
      const login = await again.response.text();
      expect(login).toContain('Payments console asks for a password and a second step');
      const second = await browser.submit(again.url, formAction(login), {
        email: people.Fay!.email!,
        password: passwords.Fay!,
      });
      const html = await second.response.text();
      expect(html).not.toContain('totp/skip');
      const secret = /data-secret>([^<]+)</.exec(html)![1]!;
      const stepped = await browser.submit(second.url, actionOf(html, /totp\/enroll/), { code: codeFor(secret) }, back);
      const { claims } = await strong.complete(stepped.url);
      expect(claims.acr).toBe('urn:landbright:acr:mfa');
    });

    it('acr_values raises what one request needs; a passkey is needed for phr', async () => {
      const page = await password(new Browser(), plain, 'Eli', { acr_values: 'urn:landbright:acr:phr' });
      expect(page.response.status).toBe(403);
      expect(page.html).toContain('This app needs a passkey');
    });
  });

  describe('recovery codes and the account page', () => {
    let browser: Browser;
    let account: string;
    const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;

    it('signs in to the account page through the account client', async () => {
      browser = new Browser();
      const start = await browser.navigate(`${stack.idp}/account`);
      const login = await start.response.text();
      expect(login).toContain('Your Landbright account');
      const second = await browser.submit(start.url, formAction(login), {
        email: people.Dana!.email!,
        password: passwords.Dana!,
      });
      const html = await second.response.text();
      expect(html).toContain('Enter your code');
      const page = await browser.submit(second.url, actionOf(html, /\/totp/), { code: codeFor(danaSecret, 30_000) });
      expect(page.url).toBe(`${stack.idp}/account`);
      account = await page.response.text();
      expect(account).toContain('Dana Test');
      expect(account).toContain('Authenticator app');
      expect(account).toContain('This browser');
    });

    it('creates recovery codes, shown once; one stands in for the second step, once', async () => {
      const created = await browser.submit(`${stack.idp}/account`, '/account/recovery-codes', {
        csrf: csrfOf(account),
      });
      const html = await created.response.text();
      codes = [...html.matchAll(/<code>([a-z0-9-]{14})<\/code>/g)].map((m) => m[1]!);
      expect(codes).toHaveLength(10);
      const forged = await browser.submit(`${stack.idp}/account`, '/account/recovery-codes', { csrf: 'forged' });
      expect(forged.response.status).toBe(403);

      const other = new Browser();
      const step = await password(other, plain, 'Dana');
      expect(step.html).toContain('Use a recovery code');
      const landed = await other.submit(step.url, actionOf(step.html, /\/recovery/), { code: codes[0]! }, back);
      expect((await plain.complete(landed.url)).claims.amr).toEqual(['pwd', 'otp', 'mfa']);

      const third = new Browser();
      const again = await password(third, plain, 'Dana');
      const reused = await third.submit(again.url, actionOf(again.html, /\/recovery/), {
        code: codes[0]!.toUpperCase(),
      });
      expect(await reused.response.text()).toContain('That recovery code didn’t work');
      expect(Person.parse(await (await api(`/api/people/${people.Dana!.id}`)).json()).recoveryCodes).toBe(9);
    });

    it('changes the password with the current one, and signs out other browsers', async () => {
      const page = await browser.navigate(`${stack.idp}/account`);
      const html = await page.response.text();
      expect(html).toContain('Another browser');
      const wrong = await browser.submit(page.url, '/account/password', {
        csrf: csrfOf(html),
        current: 'not-it-at-all-really',
        password: 'Dana-third-horse-battery',
        confirm: 'Dana-third-horse-battery',
      });
      expect(await wrong.response.text()).toContain('current password isn’t right');
      const changed = await browser.submit(page.url, '/account/password', {
        csrf: csrfOf(html),
        current: passwords.Dana!,
        password: 'Dana-third-horse-battery',
        confirm: 'Dana-third-horse-battery',
      });
      passwords.Dana = 'Dana-third-horse-battery';
      expect(await changed.response.text()).toContain('Your password is changed');
      const ended = await browser.submit(page.url, '/account/sessions/end-others', { csrf: csrfOf(html) });
      const after = await ended.response.text();
      expect(after).toContain('signed out everywhere else');
      expect(after).not.toContain('Another browser');
    });

    it('removes the authenticator app (the organization doesn’t require one), and its recovery codes with it', async () => {
      const page = await browser.navigate(`${stack.idp}/account`);
      const html = await page.response.text();
      const remove = actionOf(html, /\/remove/);
      const removed = await browser.submit(page.url, remove, { csrf: csrfOf(html) });
      const after = await removed.response.text();
      expect(after).toContain('Removed.');
      expect(after).toContain('None yet: your password alone signs you in.');
      const person = Person.parse(await (await api(`/api/people/${people.Dana!.id}`)).json());
      expect(person).toMatchObject({ hasTotp: false, recoveryCodes: 0 });
    });
  });

  describe('the machine API for people and groups', () => {
    let engineers: GroupDetail;

    it('reads a person and finds a group by name', async () => {
      engineers = GroupDetail.parse(
        await (await api('/api/groups', json({ name: 'Engineers', kind: 'birthright' }))).json(),
      );
      const person = await machine(`/api/v1/people/${people.Eli!.id}`);
      await expectStatus(person, 200);
      expect(Person.parse(await person.json()).email).toBe(people.Eli!.email);
      const found = GroupList.parse(await (await machine('/api/v1/groups?name=Engineers')).json());
      expect(found.items.map((g) => g.id)).toEqual([engineers.id]);
      expect(GroupList.parse(await (await machine('/api/v1/groups?name=Nope')).json()).items).toEqual([]);
    });

    it('adds a birthright member (source hr), twice without harm, and removes them', async () => {
      const add = () => machine(`/api/v1/groups/${engineers.id}/members`, json({ identityId: people.Eli!.id }));
      await expectStatus(await add(), 200);
      const again = GroupDetail.parse(await (await add()).json());
      expect(again.members).toHaveLength(1);
      expect(again.members[0]).toMatchObject({ id: people.Eli!.id, source: 'hr' });
      const removed = await machine(`/api/v1/groups/${engineers.id}/members/${people.Eli!.id}`, { method: 'DELETE' });
      expect(GroupDetail.parse(await removed.json()).members).toEqual([]);
    });

    it('never adds anyone to the administrators’ group', async () => {
      const admins = GroupList.parse(await (await machine('/api/v1/groups?name=Landbright%20Admins')).json()).items[0]!;
      const refused = await machine(`/api/v1/groups/${admins.id}/members`, json({ identityId: people.Eli!.id }));
      expect(refused.status).toBe(403);
    });
  });

  it('records it all in the audit log', async () => {
    const page = (await (await api('/api/audit?limit=200')).json()) as { items: Array<{ action: string }> };
    const actions = new Set(page.items.map((e) => e.action));
    for (const action of [
      'credential.password_reset',
      'identity.required_actions_set',
      'identity.terms_accepted',
      'credential.recovery_codes_created',
      'credential.recovery_code_used',
      'credential.removed',
      'session.others_ended',
    ])
      expect(actions).toContain(action);
  });
});
