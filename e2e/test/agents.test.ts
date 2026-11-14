import {
  AccessRequestView,
  Agent,
  Application,
  ApplicationWithSecret,
  Bundle,
  CIBA_GRANT,
  DEVICE_CODE_GRANT,
  GroupDetail,
  Person,
  TOKEN_EXCHANGE_GRANT,
} from '@landbright/contracts';
import { type CryptoKey, decodeJwt, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { LandflowLikeRp } from './landflow-rp';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const MACHINE_API = 'urn:landbright:api';

type Tokens = {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  issued_token_type?: string;
  error?: string;
  error_description?: string;
};

/**
 * Spec 005, slice 3, agents end to end: an agent's own application (private_key_jwt with the agent's public keys),
 * token exchange with `act`, CIBA with the decision on Landbright's page, the device grant, PAR, and DPoP-bound
 * tokens on the machine API.
 */
describe.skipIf(!e2eEnabled)('agents end to end', () => {
  let stack: Stack;
  const admin = new Browser();
  const back = (u: URL) => u.href.startsWith('http://127.0.0.1:3000/');
  const people: Record<string, Person> = {};
  const passwords: Record<string, string> = {};
  let agent: Agent;
  let app: Application;
  let privateKey: CryptoKey;
  let kid: string;
  let wiki: LandflowLikeRp;
  let wikiApp: ApplicationWithSecret;
  let bundle: Bundle;
  let discovery: Record<string, string & string[]>;

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
  async function expectStatus(response: Response, status: number) {
    if (response.status !== status) expect(`${response.status} ${await response.clone().text()}`).toBe(String(status));
  }

  async function mail(email: string, subject: string): Promise<{ Text: string }> {
    for (let i = 0; i < 40; i++) {
      const search = (await (
        await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}" subject:"${subject}"`)}`)
      ).json()) as { messages: Array<{ ID: string }> };
      if (search.messages[0])
        return (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0].ID}`)).json()) as never;
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

  /**
   * Signs `name` in on a sign-in page reached in `browser` (password, then *Not now* for the second step), and follows
   * on until `stop` or a page.
   */
  async function signIn(
    browser: Browser,
    page: { response: Response; url: string },
    name: string,
    stop?: (u: URL) => boolean,
  ) {
    const after = await browser.submit(
      page.url,
      formAction(await page.response.text()),
      { email: people[name]!.email!, password: passwords[name]! },
      stop,
    );
    if (stop?.(new URL(after.url))) return after;
    const html = await after.response.clone().text();
    const skip = /action="([^"]+\/totp\/skip)"/.exec(html)?.[1];
    return skip ? browser.submit(after.url, skip, {}, stop) : after;
  }

  /** A client assertion (RFC 7523) signed with the agent's private key. */
  const assertion = () =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuer(app.clientId)
      .setSubject(app.clientId)
      .setAudience(stack.issuer)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(privateKey);

  /** A request to one of the provider's endpoints as the agent's application. */
  async function asAgent(endpoint: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({
        client_id: app.clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await assertion(),
        ...fields,
      }),
    });
    return { status: response.status, body: (await response.json()) as Tokens & Record<string, string> };
  }

  /** Signs `name` in to the Wiki and returns their (opaque) access token. */
  async function personToken(name: string): Promise<string> {
    const browser = new Browser();
    const login = await browser.navigate(await wiki.authorizationUrl(), {}, back);
    const done = await signIn(browser, login, name, back);
    return (await wiki.complete(done.url)).accessToken;
  }

  const exchange = (subjectToken: string, extra: Record<string, string> = {}) =>
    asAgent(discovery.token_endpoint, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      ...extra,
    });

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

  it('sets up: people, an agent Ana sponsors, its application with a public key, a Wiki and a bundle', async () => {
    for (const name of ['Ana', 'Bo']) await addPerson(name);
    const created = await api(
      '/api/agents',
      json({
        displayName: 'Release bot',
        sponsorId: people.Ana!.id,
        purpose: 'Cuts releases for Ana',
        runtime: 'claude_code',
        maxTokenTtlSeconds: 300,
        actFor: 'sponsor',
      }),
    );
    await expectStatus(created, 201);
    agent = Agent.parse(await created.json());
    expect(agent.application).toBeNull();

    const pair = await generateKeyPair('ES256', { extractable: true });
    privateKey = pair.privateKey;
    kid = 'release-bot-1';
    const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid, alg: 'ES256', use: 'sig' };

    // A private key is refused: it never leaves the agent.
    const leaked = await api(
      `/api/agents/${agent.id}/application`,
      json({ jwks: { keys: [{ ...(await exportJWK(pair.privateKey)), kid }] } }),
    );
    await expectStatus(leaked, 400);

    const registered = await api(`/api/agents/${agent.id}/application`, json({ jwks: { keys: [publicJwk] } }));
    await expectStatus(registered, 201);
    app = Application.parse(await registered.json());
    expect(app).toMatchObject({ agentId: agent.id, tokenEndpointAuthMethod: 'private_key_jwt', keys: 1 });
    expect(app.grantTypes).toEqual(['client_credentials', TOKEN_EXCHANGE_GRANT, CIBA_GRANT, DEVICE_CODE_GRANT]);
    expect(app.apiScopes).toEqual(['requests:read', 'requests:create']);
    await expectStatus(await api(`/api/agents/${agent.id}/application`, json({ jwks: { keys: [publicJwk] } })), 409);
    await expectStatus(await api(`/api/applications/${app.id}/rotate-secret`, { method: 'POST' }), 409);
    expect(Agent.parse(await (await api(`/api/agents/${agent.id}`)).json()).application?.clientId).toBe(app.clientId);

    const wikiCreated = await api(
      '/api/applications',
      json({ name: 'Wiki', clientId: `wiki-${stack.slug}`, redirectUris: ['http://127.0.0.1:3000/callback'] }),
    );
    await expectStatus(wikiCreated, 201);
    wikiApp = ApplicationWithSecret.parse(await wikiCreated.json());
    wiki = new LandflowLikeRp({
      issuer: stack.issuer,
      clientId: wikiApp.application.clientId,
      clientSecret: wikiApp.clientSecret,
      redirectUri: 'http://127.0.0.1:3000/callback',
      scopes: 'openid email profile',
      roleMap: {},
    });

    const groups = (await (await api('/api/groups')).json()) as { items: Array<{ id: string; system: boolean }> };
    const admins = groups.items.find((g) => g.system)!;
    const group = await api('/api/groups', json({ name: `Deployers ${stack.slug}`, kind: 'jit' }));
    await expectStatus(group, 201);
    const deployers = GroupDetail.parse(await group.json());
    const b = await api(
      '/api/bundles',
      json({
        name: 'Deployers',
        groupIds: [deployers.id],
        policy: {
          agentsAllowed: true,
          steps: [{ name: 'Admin', approvers: { groupIds: [admins.id] } }],
          maxDurationMinutes: 60,
          reason: { mode: 'optional' },
        },
      }),
    );
    await expectStatus(b, 201);
    bundle = Bundle.parse(await b.json());

    discovery = await wiki.discovery();
    expect(discovery.grant_types_supported).toEqual(
      expect.arrayContaining([TOKEN_EXCHANGE_GRANT, CIBA_GRANT, DEVICE_CODE_GRANT, 'client_credentials']),
    );
    expect(discovery.token_endpoint_auth_methods_supported).toContain('private_key_jwt');
    expect(discovery.backchannel_authentication_endpoint).toBe(`${stack.issuer}/backchannel`);
    expect(discovery.device_authorization_endpoint).toBe(`${stack.issuer}/device/auth`);
    expect(discovery.pushed_authorization_request_endpoint).toBe(`${stack.issuer}/request`);
    expect(discovery.dpop_signing_alg_values_supported).toContain('ES256');
  });

  it('client credentials with private_key_jwt: the agent itself, for no longer than its own lifetime', async () => {
    const issued = await asAgent(discovery.token_endpoint, {
      grant_type: 'client_credentials',
      scope: 'requests:read requests:create',
      resource: MACHINE_API,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.expires_in).toBe(300);
    const claims = decodeJwt(issued.body.access_token!);
    expect(claims).toMatchObject({ sub: app.clientId, aud: MACHINE_API });

    // An agent asks for itself only.
    const forAna = await fetch(`${stack.control}/api/v1/requests`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.body.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bundleId: bundle.id, subjectId: people.Ana!.id }),
    });
    expect(forAna.status).toBe(400);
    expect(await forAna.text()).toContain('for itself only');

    // A bad signature (someone else's key) gets nothing.
    const other = await generateKeyPair('ES256');
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuer(app.clientId)
      .setSubject(app.clientId)
      .setAudience(stack.issuer)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(other.privateKey);
    const refused = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: app.clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: forged,
      }),
    });
    expect(refused.status).toBe(401);
  });

  it('token exchange: Ana’s token becomes the agent’s, acting for her; the request names her', async () => {
    const anaToken = await personToken('Ana');
    const exchanged = await exchange(anaToken, { resource: MACHINE_API, scope: 'requests:create requests:read' });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body).toMatchObject({ issued_token_type: ACCESS_TOKEN_TYPE, token_type: 'Bearer' });
    expect(exchanged.body.expires_in).toBeLessThanOrEqual(300);
    const claims = decodeJwt(exchanged.body.access_token!);
    expect(claims).toMatchObject({
      sub: people.Ana!.id,
      aud: MACHINE_API,
      client_id: app.clientId,
      scope: 'requests:create requests:read',
      act: { sub: agent.id, client_id: app.clientId },
    });

    const filed = await fetch(`${stack.control}/api/v1/requests`, {
      method: 'POST',
      headers: { authorization: `Bearer ${exchanged.body.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bundleId: bundle.id, subjectId: agent.id, reason: 'Cut release 1.4' }),
    });
    await expectStatus(filed, 201);
    const request = AccessRequestView.parse(await filed.json());
    expect(request.requester.id).toBe(agent.id);
    expect(request.actingFor?.id).toBe(people.Ana!.id);

    // Exchanging its own exchanged token again: the same actor, not a second one.
    const again = await exchange(exchanged.body.access_token!, { resource: MACHINE_API, scope: 'requests:read' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(decodeJwt(again.body.access_token!).act).toEqual({ sub: agent.id, client_id: app.clientId });

    // For another application: the scopes Ana's token had.
    const forWiki = await exchange(anaToken, { audience: wikiApp.application.clientId });
    expect(forWiki.status, JSON.stringify(forWiki.body)).toBe(200);
    expect(decodeJwt(forWiki.body.access_token!)).toMatchObject({ aud: wikiApp.application.clientId });
    expect(forWiki.body.scope!.split(' ').sort()).toEqual(['email', 'openid', 'profile']);
  });

  it('token exchange is refused for someone the agent may not act for, and for an application that isn’t an agent’s', async () => {
    const boToken = await personToken('Bo');
    const refused = await exchange(boToken);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: 'invalid_grant' });
    expect(refused.body.error_description).toContain('only for its sponsor');

    const wikiTries = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${wikiApp.application.clientId}:${wikiApp.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: boToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
      }),
    });
    expect(wikiTries.status).toBe(400);
    const wikiBody = (await wikiTries.json()) as Tokens;
    expect(wikiBody).toMatchObject({
      error: 'invalid_request',
      error_description: 'requested grant type is not allowed for this client',
    });

    const audit = (await (await api('/api/audit?limit=50')).json()) as {
      items: Array<{ action: string; data: unknown }>;
    };
    expect(audit.items.filter((e) => e.action === 'token.exchanged').length).toBeGreaterThanOrEqual(3);
  });

  it('CIBA: the agent asks Ana; she approves on Landbright’s page; the agent polls and gets her tokens', async () => {
    const asked = await asAgent(discovery.backchannel_authentication_endpoint, {
      login_hint: people.Ana!.email!,
      scope: 'openid profile',
      binding_message: 'REL-14',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const id = asked.body.auth_req_id!;
    const poll = () => asAgent(discovery.token_endpoint, { grant_type: CIBA_GRANT, auth_req_id: id });
    expect((await poll()).body.error).toBe('authorization_pending');

    const audit = (await (await api('/api/audit?limit=20')).json()) as {
      items: Array<{ action: string; data: { link?: string; bindingMessage?: string; person?: { email: string } } }>;
    };
    const event = audit.items.find((e) => e.action === 'ciba.requested')!;
    expect(event.data).toMatchObject({ bindingMessage: 'REL-14', person: { email: people.Ana!.email } });
    const link = event.data.link!;
    expect(link).toBe(`${new URL(stack.issuer).origin}/ciba/${id}`);

    // Bo opening Ana's link is told it isn't theirs.
    const bo = new Browser();
    const boPage = await signIn(bo, await bo.navigate(link), 'Bo');
    expect(boPage.response.status).toBe(403);

    const ana = new Browser();
    const page = await signIn(ana, await ana.navigate(link), 'Ana');
    const html = await page.response.text();
    expect(html).toContain('Release bot asks to act for you');
    expect(html).toContain('REL-14');
    expect(html).toMatch(/This request ends in (9|10) min/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const decided = await ana.submit(page.url, `/ciba/${id}`, { csrf, decision: 'approve' });
    expect(await decided.response.text()).toContain('Approved');

    const tokens = await poll();
    expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
    expect(decodeJwt(tokens.body.id_token!).sub).toBe(people.Ana!.id);
    // Her CIBA token, exchanged for the machine API, says the agent acts for her.
    const exchanged = await exchange(tokens.body.access_token!, { resource: MACHINE_API, scope: 'requests:read' });
    expect(decodeJwt(exchanged.body.access_token!)).toMatchObject({ sub: people.Ana!.id });
    expect(decodeJwt(exchanged.body.access_token!).act).toEqual({ sub: agent.id, client_id: app.clientId });
    // The event Landflow gets says when the request ends (its lifetime, not the epoch).
    expect(Date.parse(String((event.data as { expiresAt?: string }).expiresAt)) - Date.now()).toBeGreaterThan(
      5 * 60_000,
    );
  });

  it('CIBA: a denial reaches the agent; Bo can’t be asked; an unknown address is unknown', async () => {
    const asked = await asAgent(discovery.backchannel_authentication_endpoint, {
      login_hint: people.Ana!.email!,
      scope: 'openid',
    });
    const id = asked.body.auth_req_id!;
    const ana = new Browser();
    const page = await signIn(ana, await ana.navigate(`${new URL(stack.issuer).origin}/ciba/${id}`), 'Ana');
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.response.text())![1]!;
    await ana.submit(page.url, `/ciba/${id}`, { csrf, decision: 'deny' });
    const answer = await asAgent(discovery.token_endpoint, { grant_type: CIBA_GRANT, auth_req_id: id });
    expect(answer.body.error).toBe('access_denied');

    const bo = await asAgent(discovery.backchannel_authentication_endpoint, {
      login_hint: people.Bo!.email!,
      scope: 'openid',
    });
    expect(bo.body.error).toBe('access_denied');
    const nobody = await asAgent(discovery.backchannel_authentication_endpoint, {
      login_hint: `nobody@${stack.slug}.test`,
      scope: 'openid',
    });
    expect(nobody.body.error).toBe('unknown_user_id');
  });

  it('the device grant: Ana enters the code, signs in, and the agent gets her tokens', async () => {
    const started = await asAgent(discovery.device_authorization_endpoint, { scope: 'openid profile' });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const { device_code: deviceCode, user_code: userCode, verification_uri: verify } = started.body;
    expect(userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    const poll = () => asAgent(discovery.token_endpoint, { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode! });
    expect((await poll()).body.error).toBe('authorization_pending');

    const ana = new Browser();
    const input = await ana.navigate(verify!);
    const inputHtml = await input.response.text();
    expect(inputHtml).toContain('Connect a device');
    const confirm = await ana.submit(input.url, formAction(inputHtml), {
      xsrf: /name="xsrf" value="([^"]+)"/.exec(inputHtml)![1]!,
      user_code: userCode!,
    });
    const confirmHtml = await confirm.response.text();
    expect(confirmHtml).toContain('Release bot');
    expect(confirmHtml).toContain('act for you');
    const signInPage = await ana.submit(confirm.url, formAction(confirmHtml), {
      xsrf: /name="xsrf" value="([^"]+)"/.exec(confirmHtml)![1]!,
      user_code: userCode!,
      confirm: 'yes',
    });
    const done = await signIn(ana, signInPage, 'Ana');
    expect(await done.response.text()).toContain('is connected');

    const tokens = await poll();
    expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
    expect(decodeJwt(tokens.body.id_token!).sub).toBe(people.Ana!.id);
    expect(tokens.body.expires_in).toBeLessThanOrEqual(300);
  });

  it('the device grant refuses Bo: the agent acts only for its sponsor', async () => {
    const started = await asAgent(discovery.device_authorization_endpoint, { scope: 'openid' });
    const bo = new Browser();
    const input = await bo.navigate(started.body.verification_uri_complete!);
    const html = await input.response.text();
    const signInPage = await bo.submit(input.url, formAction(html), {
      xsrf: /name="xsrf" value="([^"]+)"/.exec(html)![1]!,
      user_code: started.body.user_code!,
      confirm: 'yes',
    });
    const done = await signIn(bo, signInPage, 'Bo');
    expect(await done.response.text()).toContain('acts only for its sponsor');
    const answer = await asAgent(discovery.token_endpoint, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: started.body.device_code!,
    });
    expect(answer.body.error).toBe('access_denied');
  });

  it('PAR: the Wiki pushes its request first and signs Ana in with a request_uri', async () => {
    const url = new URL(await wiki.authorizationUrl());
    const pushed = await fetch(discovery.pushed_authorization_request_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${wikiApp.application.clientId}:${wikiApp.clientSecret}`).toString('base64')}`,
      },
      body: url.searchParams,
    });
    expect(pushed.status).toBe(201);
    const { request_uri: requestUri } = (await pushed.json()) as { request_uri: string };
    expect(requestUri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
    const browser = new Browser();
    const login = await browser.navigate(
      `${discovery.authorization_endpoint}?${new URLSearchParams({ client_id: wikiApp.application.clientId, request_uri: requestUri })}`,
      {},
      back,
    );
    const done = await signIn(browser, login, 'Ana', back);
    expect((await wiki.complete(done.url)).claims.sub).toBe(people.Ana!.id);
  });

  it('DPoP: the agent’s token is bound to its key; the machine API wants a fresh proof each time', async () => {
    const dpopKeys = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(dpopKeys.publicKey);
    const proof = (htm: string, htu: string, ath?: string) =>
      new SignJWT({ htm, htu, ...(ath && { ath }) })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
        .setJti(randomUUID())
        .setIssuedAt()
        .sign(dpopKeys.privateKey);
    const issued = await asAgent(
      discovery.token_endpoint,
      { grant_type: 'client_credentials', scope: 'requests:read', resource: MACHINE_API },
      { dpop: await proof('POST', discovery.token_endpoint) },
    );
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.token_type).toBe('DPoP');
    const token = issued.body.access_token!;
    expect((decodeJwt(token).cnf as { jkt: string }).jkt).toBeTruthy();

    const url = `${stack.control}/api/v1/grants`;
    const ath = createHash('sha256').update(token).digest('base64url');
    const once = await proof('GET', url, ath);
    const ok = await fetch(url, { headers: { authorization: `DPoP ${token}`, dpop: once } });
    await expectStatus(ok, 200);
    // The same proof twice, the token as a bearer token, or a proof for another URL: refused.
    expect((await fetch(url, { headers: { authorization: `DPoP ${token}`, dpop: once } })).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const elsewhere = await proof('GET', `${stack.control}/api/v1/requests/x`, ath);
    expect((await fetch(url, { headers: { authorization: `DPoP ${token}`, dpop: elsewhere } })).status).toBe(401);
  });

  it('suspending the agent stops its application at once', async () => {
    await expectStatus(await api(`/api/agents/${agent.id}/suspend`, { method: 'POST' }), 200);
    const refused = await asAgent(discovery.token_endpoint, {
      grant_type: 'client_credentials',
      scope: 'requests:read',
      resource: MACHINE_API,
    });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe('invalid_client');
    await expectStatus(await api(`/api/agents/${agent.id}/resume`, { method: 'POST' }), 200);
  });
});
