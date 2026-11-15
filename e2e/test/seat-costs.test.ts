import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccessRequestView, ApplicationWithSecret, Bundle, GroupDetail, Person } from '@landbright/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

/**
 * Seat costs and the cost gate (spec 008), against the built stack. A bundle's target costs a seat on Landledger's
 * *linear* contract, and its policy opens with a step Landledger settles, through the application Landflow runs its
 * flow as (`steps:settle`). The gate can end a request or pass it to the people; it never approves access.
 *
 * Tal asks; nobody can vote while the gate waits; the flow settles it (approve) and Dana, named by the people step,
 * decides. Then the gate's denial, a rule that waits for the gate, break-glass that skips it, an extension, the wrong
 * callers, and the gate's own clock: it runs out, and escalation counts from the people's step, never the gate's.
 */

describe.skipIf(!e2eEnabled)('seat costs and the cost gate', () => {
  let stack: Stack;
  let hook: Server;
  let hookUrl: string;
  const received: Array<{ path: string; body: string }> = [];
  const admin = new Browser();
  const people: Record<string, Browser> = {};
  let users: GroupDetail;
  let approvers: GroupDetail;
  let backups: GroupDetail;
  let tal: Person;
  let dana: Person;
  let eli: Person;
  let landflow: ApplicationWithSecret;
  let other: ApplicationWithSecret;
  let settler: string;
  let otherToken: string;
  let readOnly: string;
  let seat: Bundle;
  let first: AccessRequestView;

  const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) });
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
  const machine = (path: string, init: RequestInit = {}, token = settler) =>
    fetch(`${stack.control}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  const settle = (id: string, step: number, body: unknown, token = settler) =>
    machine(`/api/v1/requests/${id}/steps/${step}/settle`, json(body), token);
  const ledger = (id: string, url = true) => ({
    system: 'Landledger',
    id,
    ...(url && { url: `http://127.0.0.1:57700/requests/${id}` }),
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

  const events = (type: string) =>
    received
      .filter((r) => r.path === '/hook')
      .map((r) => JSON.parse(r.body) as { type: string; target: { id: string }; data: Record<string, unknown> })
      .filter((e) => e.type === type);

  async function audit(action: string, targetId: string) {
    const page = (await (await api('/api/audit?limit=200')).json()) as {
      items: Array<{ action: string; targetId: string | null; data: Record<string, unknown> }>;
    };
    return page.items.filter((e) => e.action === action && e.targetId === targetId);
  }

  async function signIn(browser: Browser, email: string, password: string) {
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
    await signIn(session, email, password);
    people[givenName] = session;
    return created;
  }

  async function app(name: string, apiScopes: string[]) {
    const res = await api(
      '/api/applications',
      json({
        name,
        clientId: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stack.slug}`,
        redirectUris: ['http://127.0.0.1:3000/api/auth/oidc/callback'],
        grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
        apiScopes,
      }),
    );
    await expectStatus(res, 201);
    return ApplicationWithSecret.parse(await res.json());
  }

  async function token(a: ApplicationWithSecret, scope: string) {
    const res = await fetch(`${stack.issuer}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${a.application.clientId}:${a.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
    });
    await expectStatus(res, 200);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  const gate = (deadlineMinutes = 60) => ({
    kind: 'external',
    name: 'Cost',
    system: 'Landledger',
    settledBy: landflow.application.clientId,
    deadlineMinutes,
  });
  const peopleStep = () => ({ name: 'Tool owners', approvers: { groupIds: [approvers.id] } });

  async function bundle(name: string, policy: Record<string, unknown>) {
    const res = await api(
      '/api/bundles',
      json({
        name,
        groupIds: [users.id],
        targets: [
          {
            key: 'linear:seat',
            type: 'linear-seat',
            label: 'Linear',
            cost: { kind: 'seat', landbrightApp: 'linear' },
          },
        ],
        policy: { decisionDeadlineMinutes: 30, ...policy },
      }),
    );
    await expectStatus(res, 201);
    return Bundle.parse(await res.json());
  }

  async function ask(who: string, bundleId: string, extra: Record<string, unknown> = {}) {
    const res = await as(people[who]!)(
      '/api/access/requests',
      json({ bundleId, durationMinutes: 60, reason: 'Triage the payments backlog in Linear', ...extra }),
    );
    await expectStatus(res, 201);
    return AccessRequestView.parse(await res.json());
  }

  beforeAll(async () => {
    hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body });
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((done) => hook.listen(0, '127.0.0.1', done));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
    stack = await startStack();
    await signIn(admin, stack.admin.email, stack.admin.password);
  }, 180_000);
  afterAll(async () => {
    await stack?.stop();
    hook?.close();
  });

  it('sets up: people, the settling application, a subscription', async () => {
    users = GroupDetail.parse(await (await api('/api/groups', json({ name: 'Linear Users', kind: 'jit' }))).json());
    approvers = GroupDetail.parse(await (await api('/api/groups', json({ name: 'Tool Owners' }))).json());
    backups = GroupDetail.parse(await (await api('/api/groups', json({ name: 'Tool Backups' }))).json());
    tal = await addPerson('Tal', []);
    dana = await addPerson('Dana', [approvers.id]);
    eli = await addPerson('Eli', [backups.id]);
    await addPerson('Noa', []);
    await addPerson('Ron', []);
    await addPerson('Gil', []);
    landflow = await app('Landflow', ['requests:read', 'steps:settle']);
    other = await app('Other flow', ['requests:read', 'steps:settle']);
    settler = await token(landflow, 'requests:read steps:settle');
    otherToken = await token(other, 'requests:read steps:settle');
    readOnly = await token(landflow, 'requests:read');
    const sub = await api('/api/events/subscriptions', json({ url: `${hookUrl}/hook`, events: ['request.*'] }));
    await expectStatus(sub, 201);
  });

  it('keeps a gate first, alone, followed by people, and settled by an application that exists', async () => {
    const refused = async (steps: unknown[], why: RegExp) => {
      const res = await api('/api/bundles', json({ name: `Refused ${Math.random()}`, policy: { steps } }));
      await expectStatus(res, 400);
      expect(await res.text()).toMatch(why);
    };
    await refused([peopleStep(), gate()], /comes first/);
    await refused([gate()], /people decide must follow/);
    await refused([gate(), gate(), peopleStep()], /at most one/);
    await refused([{ ...gate(), settledBy: 'nobody-has-this' }, peopleStep()], /No application has the client id/);
    await refused([{ ...gate(), settledBy: `landbright-console-${stack.slug}` }, peopleStep()], /console/);

    seat = await bundle('Linear seat', { steps: [gate(), peopleStep()], escalation: null });
    expect(seat.targets[0]!.cost).toEqual({ kind: 'seat', landbrightApp: 'linear' });
    expect(seat.policy.steps.map((s) => s.kind)).toEqual(['external', 'people']);
  });

  it('files a request that waits on the gate; nobody can vote on it', async () => {
    const before = Date.now();
    first = await ask('Tal', seat.id);
    expect(first).toMatchObject({
      status: 'pending',
      currentStep: 0,
      waitingOn: [],
      waitingOnSystem: 'Landledger',
      costs: [{ target: 'linear:seat', label: 'Linear', kind: 'seat', landbrightApp: 'linear' }],
    });
    expect(first.steps[0]).toMatchObject({ kind: 'external', system: 'Landledger', settlement: null });
    expect(first.steps[1]!.approvers.map((a) => a.id)).toEqual([dana.id]);
    // The gate's own time (60 minutes), not the policy's 30.
    expect(new Date(first.deadline).getTime() - before).toBeGreaterThan(55 * 60_000);

    const created = await until(() => events('request.created').find((e) => e.target.id === first.id));
    expect(created.data).toMatchObject({ costs: ['linear'], waitsOn: 'Landledger' });

    const vote = await as(people.Dana!)(`/api/access/requests/${first.id}/decision`, json({ outcome: 'approve' }));
    await expectStatus(vote, 403);
    expect(await vote.text()).toMatch(/settled by Landledger, not by a vote/);
  });

  it('lets only the named application settle the gate, with the scope', async () => {
    await expectStatus(await settle(first.id, 0, { outcome: 'approve', reference: ledger('LL-1') }, readOnly), 403);
    const wrongApp = await settle(first.id, 0, { outcome: 'approve', reference: ledger('LL-1') }, otherToken);
    await expectStatus(wrongApp, 403);
    expect(await wrongApp.text()).toMatch(/another application/);
    await expectStatus(await settle(first.id, 1, { outcome: 'approve', reference: ledger('LL-1') }), 400);
    await expectStatus(await settle(first.id, 0, { outcome: 'maybe', reference: ledger('LL-1') }), 400);
  });

  it('settles the gate: the people step starts with the whole decision time, and Dana decides', async () => {
    const before = Date.now();
    const res = await settle(first.id, 0, { outcome: 'approve', reference: ledger('LL-1') });
    await expectStatus(res, 200);
    const settled = AccessRequestView.parse(await res.json());
    expect(settled).toMatchObject({ status: 'pending', currentStep: 1, waitingOnSystem: null });
    expect(settled.waitingOn.map((a) => a.id)).toEqual([dana.id]);
    expect(settled.steps[0]!.settlement).toMatchObject({
      outcome: 'approve',
      reference: ledger('LL-1'),
      by: landflow.application.clientId,
    });
    expect(settled.steps[0]!.approvals).toBe(1);
    expect(settled.votes).toEqual([]); // never a person's vote
    const left = new Date(settled.deadline).getTime() - before;
    expect(left).toBeGreaterThan(29 * 60_000);
    expect(left).toBeLessThan(31 * 60_000);

    // The same answer again is fine (a retried flow); a different one isn't.
    await expectStatus(await settle(first.id, 0, { outcome: 'approve', reference: ledger('LL-1') }), 200);
    await expectStatus(await settle(first.id, 0, { outcome: 'approve', reference: ledger('LL-2') }), 409);
    await expectStatus(await settle(first.id, 0, { outcome: 'deny', reference: ledger('LL-1') }), 409);

    const step = await until(() => events('request.step_started').find((e) => e.target.id === first.id));
    expect(step.data).toMatchObject({ step: 1, name: 'Tool owners' });
    const log = await audit('request.step_settled', first.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.data).toMatchObject({ outcome: 'approve', system: 'Landledger', reference: ledger('LL-1') });

    const vote = await as(people.Dana!)(`/api/access/requests/${first.id}/decision`, json({ outcome: 'approve' }));
    await expectStatus(vote, 200);
    const approved = AccessRequestView.parse(await vote.json());
    expect(approved).toMatchObject({ status: 'approved', method: 'reviewed' });
    expect(approved.grant?.status).toBe('active');
    first = approved;
  });

  it('ends a request the gate denies', async () => {
    const r = await ask('Noa', seat.id);
    const res = await settle(r.id, 0, {
      outcome: 'deny',
      reference: ledger('LL-3', false),
      reason: 'No seats left on the Linear contract',
    });
    await expectStatus(res, 200);
    const denied = AccessRequestView.parse(await res.json());
    expect(denied).toMatchObject({ status: 'denied', closingReason: 'step_denied' });
    expect(denied.steps[0]!.settlement).toMatchObject({
      outcome: 'deny',
      reason: 'No seats left on the Linear contract',
    });
    const decided = await audit('request.decided', r.id);
    expect(decided[0]!.data).toMatchObject({ outcome: 'denied', by: 'Landledger', reference: 'LL-3' });
    await expectStatus(await settle(r.id, 0, { outcome: 'deny', reference: ledger('LL-3', false) }), 200);
  });

  it('lets an auto-approve rule approve only once the gate is passed', async () => {
    const auto = await bundle('Linear seat (auto)', {
      steps: [gate(), peopleStep()],
      autoApprove: [{ name: 'Anyone, briefly' }],
    });
    const r = await ask('Ron', auto.id);
    expect(r).toMatchObject({ status: 'pending', waitingOnSystem: 'Landledger', autoApproval: null });
    const res = await settle(r.id, 0, { outcome: 'approve', reference: ledger('LL-4') });
    const approved = AccessRequestView.parse(await res.json());
    expect(approved).toMatchObject({ status: 'approved', method: 'auto' });
    expect(approved.autoApproval).toMatchObject({ rule: 'Anyone, briefly', after: 'Cost' });
  });

  it('skips the gate on break-glass, and says so to the flow', async () => {
    const glass = await bundle('Linear seat (break-glass)', {
      steps: [gate(), peopleStep()],
      breakGlass: { allowed: true },
    });
    const r = await ask('Gil', glass.id, { breakGlass: true, durationMinutes: 30 });
    expect(r).toMatchObject({ status: 'approved', method: 'break_glass' });
    const res = await settle(r.id, 0, { outcome: 'approve', reference: ledger('LL-5') });
    await expectStatus(res, 409);
    expect(await res.text()).toMatch(/break-glass; “Cost” was skipped/);
  });

  it('puts an extension through the gate too (the flow decides whether it costs anew)', async () => {
    const res = await as(people.Tal!)(
      `/api/access/grants/${first.grant!.id}/extend`,
      json({ durationMinutes: 30, reason: 'The backlog needs another half hour' }),
    );
    await expectStatus(res, 201);
    const extension = AccessRequestView.parse(await res.json());
    expect(extension).toMatchObject({ status: 'pending', waitingOnSystem: 'Landledger' });
    // Rides on the first cost request: the flow cites it.
    const settled = AccessRequestView.parse(
      await (await settle(extension.id, 0, { outcome: 'approve', reference: ledger('LL-1') })).json(),
    );
    expect(settled.currentStep).toBe(1);
    const vote = await as(people.Dana!)(`/api/access/requests/${extension.id}/decision`, json({ outcome: 'approve' }));
    await expectStatus(vote, 200);
    const grant = await (await as(people.Tal!)(`/api/access/requests/${first.id}`)).json();
    expect(AccessRequestView.parse(grant).grant?.expiresAt).not.toBe(first.grant!.expiresAt);
  });

  it('runs out on its own clock, and escalation counts from the people step', async () => {
    const quick = await bundle('Linear seat (quick gate)', { steps: [gate(1), peopleStep()] });
    const slow = await bundle('Linear seat (escalates)', {
      steps: [gate(60), peopleStep()],
      escalation: { afterMinutes: 1, toGroupIds: [backups.id] },
    });
    const ran = await ask('Noa', quick.id);
    const waits = await ask('Ron', slow.id);

    // A minute on: the quick gate has run out; the slow one is still waiting, and never escalated.
    await until(async () => {
      const r = AccessRequestView.parse(await (await api(`/api/access/requests/${ran.id}`)).json());
      return r.status === 'expired' && r;
    }, 90_000);
    const expired = await audit('request.decided', ran.id);
    expect(expired[0]!.data).toMatchObject({ outcome: 'expired', step: 'Cost', waitedOn: 'Landledger' });
    expect(await audit('request.escalated', waits.id)).toHaveLength(0);

    // The people step starts now: more than a minute after filing, but escalation waits its minute from here.
    await expectStatus(await settle(waits.id, 0, { outcome: 'approve', reference: ledger('LL-6') }), 200);
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await audit('request.escalated', waits.id)).toHaveLength(0);
    await until(async () => (await audit('request.escalated', waits.id)).length > 0, 90_000);
    const view = AccessRequestView.parse(await (await api(`/api/access/requests/${waits.id}`)).json());
    expect(view.steps[1]!.approvers.map((a) => a.id)).toContain(eli.id);
    expect(view.steps[0]!.approvers).toEqual([]);
    expect(tal.id).toBeTruthy();
  }, 240_000);
});
