import { createServer, type Server } from 'node:http';
import { ApplicationWithSecret, AuditPage, Person } from '@landbright/contracts';
import { createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { LandflowLikeRp } from './landflow-rp';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const REDIRECT = 'http://127.0.0.1:3000/api/auth/oidc/callback';

/** An application's back-channel logout endpoint: keeps what it was posted, and can refuse the next few. */
class LogoutReceiver {
  private server?: Server;
  url = '';
  tokens: string[] = [];
  refuse = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        if (this.refuse > 0) {
          this.refuse--;
          res.writeHead(503).end('busy');
          return;
        }
        const token = new URLSearchParams(body).get('logout_token');
        if (req.method !== 'POST' || !token || !/x-www-form-urlencoded/.test(req.headers['content-type'] ?? '')) {
          res.writeHead(400).end();
          return;
        }
        this.tokens.push(token);
        res.writeHead(200, { 'cache-control': 'no-store' }).end();
      });
    });
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done));
    const { port } = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${port}/oidc/backchannel-logout`;
  }

  stop(): Promise<void> {
    return new Promise((done) => (this.server ? this.server.close(() => done()) : done()));
  }
}

/**
 * OpenID Back-Channel Logout 1.0 (spec 006, slice 2), end to end: an application registered with a
 * `backchannel_logout_uri` is posted a logout token, signed by the issuer, when someone signed in to it signs out at
 * Landbright, ends their other sessions on the account page, or is deactivated; a refused delivery is tried again.
 */
describe.skipIf(!e2eEnabled)('back-channel logout end to end', () => {
  let stack: Stack;
  const admin = new Browser();
  const receiver = new LogoutReceiver();
  let app: ApplicationWithSecret;
  let rp: LandflowLikeRp;
  let jwks: JSONWebKeySet;

  const api = (path: string, init: RequestInit = {}) =>
    admin.fetch(`${stack.control}${path}`, {
      ...init,
      headers: { origin: stack.control, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');

  async function signIn(browser: Browser, startUrl: string, email: string, password: string, stop = back) {
    const page = await browser.navigate(startUrl, {}, stop);
    if (stop(new URL(page.url))) return page;
    const after = await browser.submit(page.url, formAction(await page.response.text()), { email, password }, stop);
    if (stop(new URL(after.url)) || after.response.status !== 200) return after;
    const html = await after.response.text();
    const skip = /action="([^"]+\/totp\/skip)"/.exec(html)?.[1];
    return skip ? browser.submit(after.url, skip, {}, stop) : { response: new Response(html), url: after.url };
  }

  /** Signs `browser` in to the application; answers the ID token's claims. */
  async function signInToApp(browser: Browser, email: string, password: string) {
    const landed = await signIn(browser, await rp.authorizationUrl(), email, password);
    return rp.complete(landed.url);
  }

  /** Waits for the next logout token (the worker runs every 2 s) and checks it as an application must (§2.6). */
  async function nextLogout(after: number, ms = 20_000) {
    const start = Date.now();
    while (receiver.tokens.length <= after) {
      if (Date.now() - start > ms) throw new Error('no logout token');
      await new Promise((r) => setTimeout(r, 200));
    }
    const token = receiver.tokens[after]!;
    expect(decodeProtectedHeader(token)).toMatchObject({ typ: 'logout+jwt', alg: 'RS256' });
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: stack.issuer,
      audience: app.application.clientId,
      typ: 'logout+jwt',
    });
    expect(payload.events).toEqual({ [LOGOUT_EVENT]: {} });
    expect(payload.jti).toBeTruthy();
    expect(payload.nonce).toBeUndefined();
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(120);
    return { claims: payload, ms: Date.now() - start };
  }

  beforeAll(async () => {
    await receiver.start();
    stack = await startStack();
    const toConsole = (u: URL) => u.origin === stack.control && u.pathname === '/people';
    await signIn(
      admin,
      `${stack.control}/api/auth/login?returnTo=/people`,
      stack.admin.email,
      stack.admin.password,
      toConsole,
    );
    jwks = (await (await fetch(`${stack.issuer}/jwks`)).json()) as JSONWebKeySet;
  }, 180_000);
  afterAll(async () => {
    await stack?.stop();
    await receiver.stop();
  });

  it('registers an application with a back-channel logout URI, and says it supports it', async () => {
    const discovery = (await (await fetch(`${stack.issuer}/.well-known/openid-configuration`)).json()) as Record<
      string,
      unknown
    >;
    expect(discovery).toMatchObject({ backchannel_logout_supported: true, backchannel_logout_session_supported: true });

    const bad = await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bad', redirectUris: [REDIRECT], backchannelLogoutUri: 'ftp://x.test/logout' }),
    });
    expect(bad.status).toBe(400);

    const response = await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Stand-in app', clientId: `standin-${stack.slug}`, redirectUris: [REDIRECT] }),
    });
    expect(response.status).toBe(201);
    app = ApplicationWithSecret.parse(await response.json());
    expect(app.application.backchannelLogoutUri).toBeNull();
    const patched = await api(`/api/applications/${app.application.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ backchannelLogoutUri: receiver.url }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { backchannelLogoutUri: string }).backchannelLogoutUri).toBe(receiver.url);
    rp = new LandflowLikeRp({
      issuer: stack.issuer,
      clientId: app.application.clientId,
      clientSecret: app.clientSecret,
      redirectUri: REDIRECT,
      scopes: 'openid email profile',
      roleMap: {},
    });
  });

  it('signing out at Landbright tells the application, for that session', async () => {
    const browser = new Browser();
    const { claims, idToken } = await signInToApp(browser, stack.admin.email, stack.admin.password);
    expect(claims.sid).toBeTruthy();
    const end = new URL(`${stack.issuer}/session/end`);
    end.searchParams.set('id_token_hint', idToken);
    const page = await browser.navigate(end.href);
    const html = await page.response.text();
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1];
    expect(xsrf).toBeTruthy();
    const before = receiver.tokens.length;
    const done = await browser.submit(page.url, formAction(html), { xsrf: xsrf!, logout: 'yes' });
    expect(await done.response.text()).toContain('signed out');
    const logout = await nextLogout(before);
    expect(logout.claims).toMatchObject({ sub: claims.sub, sid: claims.sid });
  });

  it('ending the other sessions on the account page tells the application about each', async () => {
    const elsewhere = new Browser();
    const other = await signInToApp(elsewhere, stack.admin.email, stack.admin.password);
    // The account page, in another browser: a session of its own, which stays.
    const here = new Browser();
    const account = await signIn(here, `${stack.idp}/account`, stack.admin.email, stack.admin.password, () => false);
    const html = await account.response.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(csrf).toBeTruthy();
    const before = receiver.tokens.length;
    await here.submit(account.url, '/account/sessions/end-others', { csrf: csrf! });
    const logout = await nextLogout(before);
    expect(logout.claims).toMatchObject({ sub: other.claims.sub, sid: other.claims.sid });
  });

  it('deactivating a person tells the application, and a refused delivery is tried again', async () => {
    const created = await api('/api/people', {
      method: 'POST',
      body: JSON.stringify({ email: `noa@${stack.slug}.test`, givenName: 'Noa', familyName: 'Test' }),
    });
    expect(created.status).toBe(201);
    const noa = Person.parse(await created.json());
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${noa.email}"`)}`)
    ).json()) as { messages: Array<{ ID: string }> };
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`)).json()) as {
      Text: string;
    };
    const link = /http:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(message.Text)![0];
    const password = 'noa-correct-horse-battery';
    const invite = new Browser();
    const page = await invite.navigate(link);
    await invite.submit(page.url, formAction(await page.response.text()), { password, confirm: password });
    const { claims } = await signInToApp(new Browser(), noa.email!, password);

    receiver.refuse = 1;
    const before = receiver.tokens.length;
    const response = await api(`/api/people/${noa.id}/deactivate`, { method: 'POST' });
    expect(response.status).toBe(200);
    const logout = await nextLogout(before, 30_000);
    expect(logout.claims).toMatchObject({ sub: noa.id, sid: claims.sid });

    const audit = AuditPage.parse(await (await api('/api/audit?limit=200')).json());
    expect(audit.chainIntact).toBe(true);
    const deactivated = audit.items.find((e) => e.action === 'identity.deactivated' && e.targetId === noa.id);
    expect(deactivated?.data).toMatchObject({ logoutsQueued: 1 });
    const failed = audit.items.find((e) => e.action === 'session.logout_failed' && e.targetId === noa.id);
    expect(failed?.data).toMatchObject({ application: app.application.clientId, reason: 'deactivated', attempts: 1 });
    const sent = audit.items.filter((e) => e.action === 'session.logout_sent').map((e) => e.data);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'signed_out' }),
        expect.objectContaining({ reason: 'sessions_ended' }),
        expect.objectContaining({ subject: noa.id, reason: 'deactivated', attempts: 2 }),
      ]),
    );
  });
});
