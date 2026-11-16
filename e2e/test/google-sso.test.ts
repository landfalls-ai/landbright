import { Application, ApplicationWithSecret, AuditPage, Person } from '@landbright/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { LandflowLikeRp } from './landflow-rp';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

/** Where Google's OIDC profile sends people back. The real URI comes from Google's SSO profile page. */
const GOOGLE_REDIRECT = 'http://127.0.0.1:3000/google/oidc/callback';

/**
 * Spec 009, slice 2: Google Workspace signs people in through Landbright with a custom OIDC SSO profile. Google sends
 * no PKCE that it documents and proves itself with the client secret; it matches the person on the ID token's `email`.
 * This plays Google's part: an application let off PKCE (only one with a secret can be), the authorization code flow
 * without PKCE and with the secret in the form, an ID token carrying the person's email, and a deactivated person
 * refused. Every other application still needs PKCE.
 */
describe.skipIf(!e2eEnabled)('signing in to Google Workspace through Landbright', () => {
  let stack: Stack;
  const admin = new Browser();
  let google: ApplicationWithSecret;
  let other: ApplicationWithSecret;
  let noa: Person;
  const password = 'noa-correct-horse-battery';

  const api = (path: string, init: RequestInit = {}) =>
    admin.fetch(`${stack.control}${path}`, {
      ...init,
      headers: { origin: stack.control, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');

  async function signIn(browser: Browser, startUrl: string, email: string, pass: string, stop = back) {
    const page = await browser.navigate(startUrl, {}, stop);
    if (stop(new URL(page.url))) return page;
    const after = await browser.submit(
      page.url,
      formAction(await page.response.text()),
      { email, password: pass },
      stop,
    );
    if (stop(new URL(after.url)) || after.response.status !== 200) return after;
    const html = await after.response.text();
    const skip = /action="([^"]+\/totp\/skip)"/.exec(html)?.[1];
    return skip ? browser.submit(after.url, skip, {}, stop) : { response: new Response(html), url: after.url };
  }

  const googleLike = (app: ApplicationWithSecret, pkce = false) =>
    new LandflowLikeRp({
      issuer: stack.issuer,
      clientId: app.application.clientId,
      clientSecret: app.clientSecret,
      redirectUri: GOOGLE_REDIRECT,
      scopes: 'openid email profile',
      roleMap: {},
      pkce,
      clientAuth: 'post',
    });

  beforeAll(async () => {
    stack = await startStack();
    const toConsole = (u: URL) => u.origin === stack.control && u.pathname === '/people';
    await signIn(
      admin,
      `${stack.control}/api/auth/login?returnTo=/people`,
      stack.admin.email,
      stack.admin.password,
      toConsole,
    );
    const created = await api('/api/people', {
      method: 'POST',
      body: JSON.stringify({ email: `noa.barak@${stack.slug}.test`, givenName: 'Noa', familyName: 'Barak' }),
    });
    expect(created.status).toBe(201);
    noa = Person.parse(await created.json());
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${noa.email}"`)}`)
    ).json()) as { messages: Array<{ ID: string }> };
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`)).json()) as {
      Text: string;
    };
    const link = /http:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(message.Text)![0];
    const invite = new Browser();
    const page = await invite.navigate(link);
    await invite.submit(page.url, formAction(await page.response.text()), { password, confirm: password });
  }, 180_000);
  afterAll(() => stack?.stop());

  it('registers Google with PKCE off and the secret in the form; PKCE stays on for everyone else', async () => {
    const response = await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Google Workspace',
        clientId: `google-${stack.slug}`,
        redirectUris: [GOOGLE_REDIRECT],
        grantTypes: ['authorization_code'],
        tokenEndpointAuthMethod: 'client_secret_post',
        pkceRequired: false,
      }),
    });
    expect(response.status).toBe(201);
    google = ApplicationWithSecret.parse(await response.json());
    expect(google.application).toMatchObject({ pkceRequired: false, tokenEndpointAuthMethod: 'client_secret_post' });

    const plain = await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Another app', clientId: `other-${stack.slug}`, redirectUris: [GOOGLE_REDIRECT] }),
    });
    other = ApplicationWithSecret.parse(await plain.json());
    expect(other.application.pkceRequired).toBe(true);

    const audit = AuditPage.parse(await (await api('/api/audit?limit=50')).json());
    expect(
      audit.items.find((e) => e.action === 'client.created' && e.targetId === `google-${stack.slug}`)?.data,
    ).toMatchObject({
      pkceRequired: false,
    });
  });

  it('signs Noa in the way Google does: no PKCE, the secret in the form, her email in the ID token', async () => {
    const rp = googleLike(google);
    const url = new URL(await rp.authorizationUrl());
    expect(url.searchParams.has('code_challenge')).toBe(false);
    const landed = await signIn(new Browser(), url.href, noa.email!, password);
    const { claims } = await rp.complete(landed.url);
    expect(claims).toMatchObject({ sub: noa.id, email: noa.email, email_verified: true });
  });

  it('still refuses an application that needs PKCE when none is sent', async () => {
    const rp = googleLike(other);
    const page = await new Browser().navigate(await rp.authorizationUrl(), {}, back);
    expect(page.url).toContain('error=invalid_request');
    expect(decodeURIComponent(page.url)).toMatch(/PKCE|code_challenge/i);
  });

  it('turns PKCE back on, and then Google’s way is refused', async () => {
    const patched = await api(`/api/applications/${google.application.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pkceRequired: true }),
    });
    expect(Application.parse(await patched.json()).pkceRequired).toBe(true);
    const page = await new Browser().navigate(await googleLike(google).authorizationUrl(), {}, back);
    expect(page.url).toContain('error=invalid_request');
    // With PKCE, the same application signs in again.
    const rp = googleLike(google, true);
    const landed = await signIn(new Browser(), await rp.authorizationUrl(), noa.email!, password);
    expect((await rp.complete(landed.url)).claims.email).toBe(noa.email);
    await api(`/api/applications/${google.application.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pkceRequired: false }),
    });
    const audit = AuditPage.parse(await (await api('/api/audit?limit=50')).json());
    const changes = audit.items.filter((e) => e.action === 'client.updated' && e.targetId === `google-${stack.slug}`);
    expect(changes.map((e) => e.data.pkceRequired)).toEqual([false, true]);
  });

  it('refuses Noa at Google once she is deactivated', async () => {
    const response = await api(`/api/people/${noa.id}/deactivate`, { method: 'POST' });
    expect(response.status).toBe(200);
    const rp = googleLike(google);
    const browser = new Browser();
    const page = await browser.navigate(await rp.authorizationUrl(), {}, back);
    const after = await browser.submit(
      page.url,
      formAction(await page.response.text()),
      { email: noa.email!, password },
      back,
    );
    expect(back(new URL(after.url))).toBe(false);
    expect(await after.response.text()).not.toContain('code=');
  });
});
