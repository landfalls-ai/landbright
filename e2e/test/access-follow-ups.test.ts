import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AccessRequestView,
  Agent,
  ApplicationWithSecret,
  Bundle,
  GroupDetail,
  Person,
  RelayTicketList,
  Subscription,
} from '@landbright/contracts';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { LandflowLikeRp } from './landflow-rp';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

/**
 * Spec 005's access follow-ups, end to end: votes relayed from a chat with Landbright's per-approver tickets, a
 * two-step policy, extensions (approved by an hours-bound auto-approve rule), requests a service files for an agent
 * and for a person, subscriptions an application manages itself, and ID tokens that end with the grant.
 *
 * Noa asks; Ron (step 1) votes "in Slack" through a flow that relays his ticket; Gil (step 2) approves on the decision
 * page. Noa then asks for more time, which a rule approves at once, and the grant's end moves.
 */

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describe.skipIf(!e2eEnabled)('access follow-ups end to end', () => {
  let stack: Stack;
  let hook: Server;
  let hookUrl: string;
  const received: Received[] = [];
  const admin = new Browser();
  const people: Record<string, Browser> = {};
  const passwords: Record<string, string> = {};
  let editors: GroupDetail;
  let leads: GroupDetail;
  let security: GroupDetail;
  let noa: Person;
  let ron: Person;
  let gil: Person;
  let agent: Agent;
  let flow: ApplicationWithSecret;
  let twoStep: Bundle;
  let quick: Bundle;
  let request: AccessRequestView;
  let token: string;

  const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
  const as =
    (browser: Browser) =>
    (path: string, init: RequestInit = {}) =>
      browser.fetch(`${stack.control}${path}`, {
        ...init,
        headers: {
          origin: stack.control,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers as Record<string, string>),
        },
      });
  const api = (path: string, init: RequestInit = {}) => as(admin)(path, init);
  const machine = (path: string, init: RequestInit = {}) =>
    fetch(`${stack.control}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string>),
      },
    });

  async function expectStatus(response: Response, status: number) {
    if (response.status !== status) expect(`${response.status} ${await response.clone().text()}`).toBe(String(status));
  }

  async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, ms = 20_000) {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function signInToConsole(browser: Browser, email: string, password: string) {
    const back = (u: URL) => u.origin === stack.control && u.pathname === '/access';
    const page = await browser.navigate(`${stack.control}/api/auth/login?returnTo=/access`, {}, back);
    const after = await browser.submit(page.url, formAction(await page.response.text()), { email, password }, back);
    if (back(new URL(after.url))) return;
    const skip = /action="([^"]+\/totp\/skip)"/.exec(await after.response.text())?.[1];
    await browser.submit(after.url, skip!, {}, back);
  }

  async function addPerson(givenName: string, groupIds: string[]): Promise<Person> {
    const email = `${givenName.toLowerCase()}@${stack.slug}.test`;
    const created = Person.parse(
      await (await api('/api/people', json({ email, givenName, familyName: 'Test', groupIds }))).json(),
    );
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    ).json()) as { messages: Array<{ ID: string }> };
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`)).json()) as {
      Text: string;
    };
    const link = /http:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(message.Text)![0];
    const browser = new Browser();
    const page = await browser.navigate(link);
    const password = `${givenName}-correct-horse-battery`;
    await browser.submit(page.url, formAction(await page.response.text()), { password, confirm: password });
    const session = new Browser();
    await signInToConsole(session, email, password);
    people[givenName] = session;
    passwords[givenName] = password;
    return created;
  }

  beforeAll(async () => {
    hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((done) => hook.listen(0, '127.0.0.1', done));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
    stack = await startStack();
    await signInToConsole(admin, stack.admin.email, stack.admin.password);
  }, 180_000);
  afterAll(async () => {
    await stack?.stop();
    hook?.close();
  });

  it('sets up: people, an agent, a flow application with the new scopes, and two bundles', async () => {
    editors = GroupDetail.parse(
      await (await api('/api/groups', json({ name: 'Payments Editors', kind: 'jit' }))).json(),
    );
    leads = GroupDetail.parse(await (await api('/api/groups', json({ name: 'Team Leads' }))).json());
    security = GroupDetail.parse(await (await api('/api/groups', json({ name: 'Security' }))).json());
    noa = await addPerson('Noa', []);
    ron = await addPerson('Ron', [leads.id]);
    gil = await addPerson('Gil', [security.id]);
    agent = Agent.parse(
      await (
        await api('/api/agents', json({ displayName: 'Payments triage bot', sponsorId: noa.id, purpose: 'Triage' }))
      ).json(),
    );

    const app = await api(
      '/api/applications',
      json({
        name: 'Approvals flow (e2e)',
        clientId: `approvals-${stack.slug}`,
        redirectUris: [`${hookUrl}/callback`],
        grantTypes: ['authorization_code', 'client_credentials'],
        apiScopes: ['requests:read', 'requests:create', 'decisions:relay', 'events:manage'],
      }),
    );
    await expectStatus(app, 201);
    flow = ApplicationWithSecret.parse(await app.json());
    const issued = await fetch(`${stack.issuer}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${flow.application.clientId}:${flow.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'requests:read requests:create decisions:relay events:manage',
      }),
    });
    await expectStatus(issued, 200);
    token = ((await issued.json()) as { access_token: string }).access_token;
    expect(String(decodeJwt(token).scope).split(' ').sort()).toEqual([
      'decisions:relay',
      'events:manage',
      'requests:create',
      'requests:read',
    ]);

    const created = await api(
      '/api/bundles',
      json({
        name: 'Payments Editors (two steps)',
        groupIds: [editors.id],
        policy: {
          agentsAllowed: true,
          steps: [
            { name: 'Team lead', approvers: { groupIds: [leads.id] }, allowRelayed: true },
            { name: 'Security', approvers: { groupIds: [security.id] } },
          ],
          maxDurationMinutes: 120,
          reason: { mode: 'optional' },
        },
      }),
    );
    await expectStatus(created, 201);
    twoStep = Bundle.parse(await created.json());
    expect(twoStep.policy.steps.map((s) => s.allowRelayed)).toEqual([true, false]);
    expect(twoStep.policy.extensions).toEqual({ allowed: true, maxCount: 2 });

    const now = new Date();
    const otherDay = (now.getUTCDay() + 3) % 7;
    const second = await api(
      '/api/bundles',
      json({
        name: 'Payments Editors (quick)',
        groupIds: [editors.id],
        policy: {
          steps: [{ name: 'Team lead', approvers: { groupIds: [leads.id] } }],
          autoApprove: [
            // Every day, all day (from = to): approves at once.
            {
              name: 'Short, any time',
              maxDurationMinutes: 30,
              window: { days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '00:00' },
            },
            // Never today: must not approve.
            { name: 'Long, another day', window: { days: [otherDay], from: '00:00', to: '00:00' } },
          ],
          extensions: { allowed: true, maxCount: 1 },
          maxDurationMinutes: 240,
          reason: { mode: 'optional' },
        },
      }),
    );
    await expectStatus(second, 201);
    quick = Bundle.parse(await second.json());
  });

  it('a two-step request: Ron votes from chat with his ticket, Gil approves on the decision page', async () => {
    const filed = await as(people.Noa!)('/api/access/requests', json({ bundleId: twoStep.id, durationMinutes: 30 }));
    await expectStatus(filed, 201);
    request = AccessRequestView.parse(await filed.json());
    expect(request.steps.map((s) => [s.name, s.allowRelayed])).toEqual([
      ['Team lead', true],
      ['Security', false],
    ]);

    const tickets = RelayTicketList.parse(
      await (await machine(`/api/v1/requests/${request.id}/relay-tickets`, { method: 'POST' })).json(),
    );
    expect(tickets.items.map((t) => t.decider.id)).toEqual([ron.id]);
    const ticket = tickets.items[0]!.ticket;

    // A ticket for another request, and a made-up one, are refused.
    const other = await machine(
      `/api/v1/requests/${twoStep.id}/decisions`,
      json({ ticket, outcome: 'approve', channel: 'chat:slack' }),
    );
    await expectStatus(other, 403);
    const forged = await machine(
      `/api/v1/requests/${request.id}/decisions`,
      json({ ticket: `${ticket.slice(0, -4)}AAAA`, outcome: 'approve', channel: 'chat:slack' }),
    );
    await expectStatus(forged, 403);

    const relayed = await machine(
      `/api/v1/requests/${request.id}/decisions`,
      json({ ticket, outcome: 'approve', channel: 'chat:slack', evidence: { slackUser: 'U0RON', team: 'T0E2E' } }),
    );
    await expectStatus(relayed, 200);
    request = AccessRequestView.parse(await relayed.json());
    expect(request).toMatchObject({ status: 'pending', currentStep: 1 });
    expect(request.votes[0]).toMatchObject({
      decider: { id: ron.id },
      channel: 'chat:slack',
      assurance: 'chat',
      submittedBy: 'Approvals flow (e2e)',
    });
    expect(request.actions.decide).toBe(false); // a service never decides

    // The same ticket again (Ron voted), and tickets for a step that doesn't allow relayed votes, are refused.
    const again = await machine(
      `/api/v1/requests/${request.id}/decisions`,
      json({ ticket, outcome: 'deny', channel: 'chat:slack' }),
    );
    await expectStatus(again, 403);
    const step2 = await machine(`/api/v1/requests/${request.id}/relay-tickets`, { method: 'POST' });
    await expectStatus(step2, 403);

    const approved = await as(people.Gil!)(`/api/access/requests/${request.id}/decision`, json({ outcome: 'approve' }));
    await expectStatus(approved, 200);
    request = AccessRequestView.parse(await approved.json());
    expect(request).toMatchObject({ status: 'approved', method: 'reviewed', grant: { status: 'active' } });
    expect(request.votes.map((v) => [v.channel, v.assurance])).toEqual([
      ['chat:slack', 'chat'],
      ['landbright', 'signed-in'],
    ]);
  });

  it('caps the ID token at the grant’s end', async () => {
    const rp = new LandflowLikeRp({
      issuer: stack.issuer,
      clientId: flow.application.clientId,
      clientSecret: flow.clientSecret,
      redirectUri: `${hookUrl}/callback`,
      scopes: 'openid roles',
      roleMap: {},
    });
    const back = (u: URL) => u.href.startsWith(`${hookUrl}/callback`);
    // Noa's browser already has a session at the identity plane (she signed in to the console).
    const landed = await people.Noa!.navigate(await rp.authorizationUrl(), {}, back);
    const result = await rp.complete(landed.url);
    expect(result.claims.roles).toEqual(['Payments Editors']);
    const claims = decodeJwt(result.idToken);
    const grantEnds = Math.floor(new Date(request.grant!.expiresAt).getTime() / 1000);
    expect(claims.exp!).toBeLessThanOrEqual(grantEnds + 1);
    // Without the cap it would be an hour (the stack's ID token lifetime); the grant has about 30 minutes left.
    expect(claims.exp! - claims.iat!).toBeLessThan(31 * 60);
  });

  it('extends a grant: a request of its own, approved by a rule within its hours; the end moves', async () => {
    // Quick bundle: the "any time, at most 30 min" rule approves at once.
    const filed = AccessRequestView.parse(
      await (await as(people.Ron!)('/api/access/requests', json({ bundleId: quick.id, durationMinutes: 20 }))).json(),
    );
    expect(filed).toMatchObject({ status: 'approved', method: 'auto' });
    expect((filed.autoApproval as { rule: string }).rule).toBe('Short, any time');
    expect(filed.actions.extend).toBe(true);
    // Longer than the first rule allows, and the second rule's day isn't today: it waits.
    const long = AccessRequestView.parse(
      await (await as(people.Gil!)('/api/access/requests', json({ bundleId: quick.id, durationMinutes: 120 }))).json(),
    );
    expect(long.status).toBe('pending');

    const before = new Date(filed.grant!.expiresAt).getTime();
    const extended = await as(people.Ron!)(
      `/api/access/grants/${filed.grant!.id}/extend`,
      json({ durationMinutes: 15 }),
    );
    await expectStatus(extended, 201);
    const extension = AccessRequestView.parse(await extended.json());
    expect(extension).toMatchObject({
      status: 'approved',
      method: 'auto',
      extends: { grantId: filed.grant!.id, ref: filed.ref },
      grant: null,
    });
    const after = AccessRequestView.parse(await (await as(people.Ron!)(`/api/access/requests/${filed.ref}`)).json());
    expect(new Date(after.grant!.expiresAt).getTime() - before).toBe(15 * 60_000);
    expect(after.actions.extend).toBe(false); // maxCount 1
    const group = GroupDetail.parse(await (await api(`/api/groups/${editors.id}`)).json());
    expect(group.members.find((m) => m.id === ron.id)).toMatchObject({ source: 'grant' });

    const third = await as(people.Ron!)(`/api/access/grants/${filed.grant!.id}/extend`, json({ durationMinutes: 15 }));
    await expectStatus(third, 400);
    const notMine = await as(people.Gil!)(
      `/api/access/grants/${filed.grant!.id}/extend`,
      json({ durationMinutes: 15 }),
    );
    await expectStatus(notMine, 403);
    const audit = (await (await api('/api/audit?limit=100')).json()) as {
      items: Array<{ action: string; data: { addedMinutes?: number } }>;
    };
    expect(audit.items.find((e) => e.action === 'grant.extended')?.data.addedMinutes).toBe(15);
  });

  it('a service files for an agent (its sponsor can’t approve) and for a person (never auto-approved)', async () => {
    const forAgent = await machine(
      '/api/v1/requests',
      json({ bundleId: twoStep.id, subjectId: agent.id, durationMinutes: 10, reason: 'Nightly triage' }),
    );
    await expectStatus(forAgent, 201);
    const a = AccessRequestView.parse(await forAgent.json());
    expect(a).toMatchObject({
      status: 'pending',
      source: 'api',
      requester: { id: agent.id },
      subject: { id: agent.id },
      actingFor: { id: noa.id },
      durationMinutes: 10,
    });
    // Agents get at most 15 minutes, whatever the bundle allows people.
    const tooLong = await machine(
      '/api/v1/requests',
      json({ bundleId: twoStep.id, subjectId: agent.id, durationMinutes: 60 }),
    );
    await expectStatus(tooLong, 400);

    // The quick bundle's rule would approve a short request at once, but a service asking for a person waits.
    const forPerson = await machine(
      '/api/v1/requests',
      json({ bundleId: quick.id, subjectId: gil.id, durationMinutes: 10 }),
    );
    // Gil already has one pending for this bundle: superseded by this one.
    await expectStatus(forPerson, 201);
    expect(AccessRequestView.parse(await forPerson.json())).toMatchObject({ status: 'pending', source: 'api' });

    const notForAgents = await machine('/api/v1/requests', json({ bundleId: quick.id, subjectId: agent.id }));
    await expectStatus(notForAgents, 400);
  });

  it('lets an application manage its own subscriptions, at its own origins only', async () => {
    const elsewhere = await machine(
      '/api/v1/subscriptions',
      json({ url: 'http://127.0.0.1:1/hook', events: ['grant.*'] }),
    );
    await expectStatus(elsewhere, 400);
    const mine = await machine('/api/v1/subscriptions', json({ url: `${hookUrl}/own`, events: ['grant.extended'] }));
    await expectStatus(mine, 201);
    const sub = Subscription.parse(await mine.json());
    expect(sub.ownerClientId).toBe(flow.application.clientId);

    const adminSub = Subscription.parse(
      await (await api('/api/events/subscriptions', json({ url: `${hookUrl}/admin`, events: ['request.*'] }))).json(),
    );
    const listed = (await (await machine('/api/v1/subscriptions')).json()) as { items: Subscription[] };
    expect(listed.items.map((s) => s.id)).toEqual([sub.id]);
    await expectStatus(await machine(`/api/v1/subscriptions/${adminSub.id}`, { method: 'DELETE' }), 404);

    // Its subscription delivers: another extension on a fresh grant.
    const filed = AccessRequestView.parse(
      await (await as(people.Noa!)('/api/access/requests', json({ bundleId: quick.id, durationMinutes: 10 }))).json(),
    );
    await as(people.Noa!)(`/api/access/grants/${filed.grant!.id}/extend`, json({ durationMinutes: 5 }));
    await until(() => received.some((r) => r.path === '/own' && JSON.parse(r.body).type === 'grant.extended'));
    await expectStatus(await machine(`/api/v1/subscriptions/${sub.id}`, { method: 'DELETE' }), 204);
  });

  it('wakes a waiting flow again when its first nudge fails', async () => {
    // A resume URL that fails once (the hook answers 503 the first time), then succeeds.
    let calls = 0;
    hook.removeAllListeners('request');
    hook.on('request', (req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        const flaky = req.url === '/resume/flaky' && calls++ === 0;
        res.writeHead(flaky ? 503 : 202, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    const sub = await api('/api/events/subscriptions', json({ url: `${hookUrl}/events`, events: ['request.created'] }));
    await expectStatus(sub, 201);
    // Gil asks (Noa already holds this bundle); Ron's vote at step 1 is the change that wakes the flow.
    const pending = AccessRequestView.parse(
      await (await as(people.Gil!)('/api/access/requests', json({ bundleId: twoStep.id, durationMinutes: 30 }))).json(),
    );
    const wait = await machine(`/api/v1/requests/${pending.id}/waits`, json({ resumeUrl: `${hookUrl}/resume/flaky` }));
    // requests:read is enough to wait; the scope set has it.
    await expectStatus(wait, 200);
    await as(people.Ron!)(`/api/access/requests/${pending.id}/decision`, json({ outcome: 'approve' }));
    await until(() => received.filter((r) => r.path === '/resume/flaky').length >= 2, 30_000);
  }, 40_000);
});
