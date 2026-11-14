import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AccessRequestView,
  ApplicationWithSecret,
  Bundle,
  GroupDetail,
  Person,
  RequestPreview,
  Subscription,
} from '@landbright/contracts';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

/**
 * Just-in-time access end to end (spec 004), with a stand-in for a Landflow flow: a local HTTP server that receives
 * Landbright's events the way a Landflow Webhook trigger with JWT Auth does (checking each delivery's JWT against the
 * issuer's JWKS), calls the machine API with a client-credentials token, attaches a wait, and reports targets.
 *
 * Tal asks for Landflow Editors; Dana, named by the policy, approves on the decision route; the grant adds Tal to the
 * group and a flow-managed target; at expiry the sweeper removes the membership whatever the flow does. Then the
 * refusals: self-approval, someone the policy doesn't name, a second vote, a late report, a forged nudge.
 */

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describe.skipIf(!e2eEnabled)('just-in-time access end to end', () => {
  let stack: Stack;
  let hook: Server;
  let hookUrl: string;
  const received: Received[] = [];
  const admin = new Browser();
  let editors: GroupDetail;
  let approvers: GroupDetail;
  let tal: Person;
  let dana: Person;
  const people: Record<string, Browser> = {};
  let landflow: ApplicationWithSecret;
  let bundle: Bundle;
  let request: AccessRequestView;
  let serviceToken: string;

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
  const machine = (path: string, init: RequestInit = {}, token = serviceToken) =>
    fetch(`${stack.control}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string>),
      },
    });

  /** The status, with the body in the message when it isn't the one expected. */
  async function expectStatus(response: Response, status: number) {
    if (response.status !== status) expect(`${response.status} ${await response.clone().text()}`).toBe(String(status));
  }

  /** Waits until `check` returns something truthy (the worker ticks every 2 s). */
  async function until<T>(
    check: () => Promise<T | undefined | false> | T | undefined | false,
    ms = 20_000,
  ): Promise<T> {
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
      .map((r) => JSON.parse(r.body))
      .filter((e) => e.type === type);

  async function signInToConsole(browser: Browser, email: string, password: string) {
    const back = (u: URL) => u.origin === stack.control && u.pathname === '/access';
    const page = await browser.navigate(`${stack.control}/api/auth/login?returnTo=/access`, {}, back);
    const after = await browser.submit(page.url, formAction(await page.response.text()), { email, password }, back);
    if (back(new URL(after.url))) return;
    const skip = /action="([^"]+\/totp\/skip)"/.exec(await after.response.text())?.[1];
    const done = await browser.submit(after.url, skip!, {}, back);
    expect(done.url).toBe(`${stack.control}/access`);
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
    return created;
  }

  beforeAll(async () => {
    hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'started', executionId: `exec-${received.length}` }));
      });
    });
    await new Promise<void>((done) => hook.listen(0, '127.0.0.1', done));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
    stack = await startStack();
    const back = (u: URL) => u.origin === stack.control && u.pathname === '/people';
    const page = await admin.navigate(`${stack.control}/api/auth/login?returnTo=/people`, {}, back);
    const after = await admin.submit(
      page.url,
      formAction(await page.response.text()),
      { email: stack.admin.email, password: stack.admin.password },
      back,
    );
    if (!back(new URL(after.url))) {
      const skip = /action="([^"]+\/totp\/skip)"/.exec(await after.response.text())?.[1];
      await admin.submit(after.url, skip!, {}, back);
    }
  }, 180_000);
  afterAll(async () => {
    await stack?.stop();
    hook?.close();
  });

  it('sets up: groups, people, Landflow with machine API scopes, a subscription and a bundle', async () => {
    editors = GroupDetail.parse(
      await (await api('/api/groups', json({ name: 'Landflow Editors', kind: 'jit' }))).json(),
    );
    approvers = GroupDetail.parse(await (await api('/api/groups', json({ name: 'Landflow Admins' }))).json());
    tal = await addPerson('Tal', []);
    dana = await addPerson('Dana', [approvers.id]);
    await addPerson('Lior', []); // in no group: never named as an approver

    const app = await api(
      '/api/applications',
      json({
        name: 'Landflow (e2e)',
        clientId: `landflow-${stack.slug}`,
        redirectUris: ['http://127.0.0.1:3000/api/auth/oidc/callback'],
        grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
        apiScopes: ['requests:read', 'grants:record', 'annotations:write', 'directory:read', 'directory:write'],
      }),
    );
    await expectStatus(app, 201);
    landflow = ApplicationWithSecret.parse(await app.json());
    expect(landflow.application.apiScopes).toContain('grants:record');

    const sub = await api(
      '/api/events/subscriptions',
      json({ url: `${hookUrl}/hook`, events: ['request.*', 'grant.*', 'group.member_*'], description: 'JIT flows' }),
    );
    await expectStatus(sub, 201);
    expect(Subscription.parse(await sub.json()).audience).toBe(hookUrl);

    const created = await api(
      '/api/bundles',
      json({
        name: 'Landflow Editors (JIT)',
        ownerId: dana.id,
        groupIds: [editors.id],
        targets: [
          {
            key: 'landflow:payments-editor',
            type: 'landflow-project-role',
            label: 'Payments project, editor',
            config: { project: 'payments', role: 'editor' },
          },
        ],
        policy: {
          steps: [{ name: 'Landflow Admins', approvers: { groupIds: [approvers.id] }, approvalsRequired: 1 }],
          maxDurationMinutes: 120,
          decisionDeadlineMinutes: 30,
          expiringNoticeMinutes: 1,
        },
      }),
    );
    await expectStatus(created, 201);
    bundle = Bundle.parse(await created.json());
    expect(bundle.policy.reason.mode).toBe('required');
  });

  it('previews and files a request; the policy names Dana', async () => {
    const tals = as(people.Tal!);
    const preview = RequestPreview.parse(
      await (await tals('/api/access/requests/preview', json({ bundleId: bundle.id, durationMinutes: 1 }))).json(),
    );
    expect(preview).toMatchObject({ eligible: true, durationMinutes: 1, maxDurationMinutes: 120 });
    expect(preview.approvers.map((a) => a.id)).toEqual([dana.id]);

    const noReason = await tals('/api/access/requests', json({ bundleId: bundle.id, durationMinutes: 1 }));
    await expectStatus(noReason, 400);
    const tooLong = await tals(
      '/api/access/requests',
      json({ bundleId: bundle.id, durationMinutes: 500, reason: 'x'.repeat(20) }),
    );
    await expectStatus(tooLong, 400);

    const filed = await tals(
      '/api/access/requests',
      json({ bundleId: bundle.id, durationMinutes: 1, reason: 'Fix the payments retry flow' }),
    );
    await expectStatus(filed, 201);
    request = AccessRequestView.parse(await filed.json());
    expect(request).toMatchObject({ status: 'pending', ref: `REQ-${request.number}`, source: 'portal' });
    expect(request.waitingOn.map((w) => w.id)).toEqual([dana.id]);
    expect(request.actions.decide).toBe(false);
    expect(request.decisionUrl).toBe(`${stack.console}/access/requests/${request.ref}`);
  });

  it('delivers request.created to the flow, signed by the issuer, once per event', async () => {
    const [delivery] = await until(() => {
      const hits = received.filter((r) => r.path === '/hook' && JSON.parse(r.body).type === 'request.created');
      return hits.length ? hits : undefined;
    });
    expect(delivery!.headers['idempotency-key']).toMatch(new RegExp(`^${stack.slug}\\.\\d+$`));
    const token = /^Bearer (.+)$/.exec(String(delivery!.headers.authorization))![1]!;
    // What Landflow's JWT Auth credential does with "JWKS URL" = the issuer's key set.
    const jwks = createRemoteJWKSet(new URL(`${stack.issuer}/jwks`));
    const { payload, protectedHeader } = await jwtVerify(token, jwks, { issuer: stack.issuer, audience: hookUrl });
    expect(protectedHeader.typ).toBe('secevent+jwt');
    expect(payload).toMatchObject({ type: 'request.created', tenant: stack.slug, sub: request.id });
    const event = payload.event as { data: { request: AccessRequestView } };
    expect(event.data.request.ref).toBe(request.ref);
    expect(event.data.request.waitingOn.map((w) => w.email)).toEqual([dana.email]);
    expect(event.data.request.actions.decide).toBe(false);
    // Someone else's audience is refused.
    await expect(
      jwtVerify(token, jwks, { issuer: stack.issuer, audience: 'https://elsewhere.test' }),
    ).rejects.toThrow();
  });

  it('gives Landflow a client-credentials token for the machine API, and nothing more', async () => {
    const tokenResponse = await fetch(`${stack.issuer}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${landflow.application.clientId}:${landflow.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'requests:read grants:record annotations:write directory:read directory:write',
      }),
    });
    await expectStatus(tokenResponse, 200);
    serviceToken = ((await tokenResponse.json()) as { access_token: string }).access_token;
    expect(serviceToken.split('.')).toHaveLength(3);

    const read = await machine(`/api/v1/requests/${request.id}`);
    await expectStatus(read, 200);
    const seen = AccessRequestView.parse(await read.json());
    expect(seen.actions).toEqual({ decide: false, cancel: false, revoke: false });
    expect((await machine(`/api/v1/requests/${request.ref}`)).status).toBe(200);

    expect((await fetch(`${stack.control}/api/v1/requests/${request.id}`)).status).toBe(401);
    expect((await machine(`/api/v1/requests/${request.id}`, {}, 'not.a.token')).status).toBe(401);
    // The console session doesn't open the machine API, and a service token doesn't open the console's.
    expect((await api(`/api/v1/requests/${request.id}`)).status).toBe(401);
    expect((await machine('/api/people')).status).toBe(401);
  });

  it('lets a flow keep notes and wait on the request, only at a subscribed origin', async () => {
    const note = await machine(`/api/v1/requests/${request.id}/annotations/landflow.run`, {
      method: 'PUT',
      body: JSON.stringify({ value: { executionId: 'exec-1' } }),
    });
    await expectStatus(note, 200);
    const stale = await machine(`/api/v1/requests/${request.id}/annotations/landflow.run`, {
      method: 'PUT',
      body: JSON.stringify({ value: {} }),
      headers: { 'if-match': '7' },
    });
    await expectStatus(stale, 409);
    const elsewhere = await machine(
      `/api/v1/requests/${request.id}/waits`,
      json({ resumeUrl: 'http://127.0.0.1:1/x' }),
    );
    await expectStatus(elsewhere, 400);
    const wait = await machine(`/api/v1/requests/${request.id}/waits`, json({ resumeUrl: `${hookUrl}/resume/exec-1` }));
    await expectStatus(wait, 200);
  });

  it('refuses a decision by the requester, by someone the policy does not name, and by the administrator', async () => {
    for (const browser of [people.Tal!, people.Lior!, admin]) {
      const refused = await as(browser)(`/api/access/requests/${request.id}/decision`, json({ outcome: 'approve' }));
      await expectStatus(refused, 403);
    }
    // Lior isn't named, so Lior can't even see it.
    expect((await as(people.Lior!)(`/api/access/requests/${request.ref}`)).status).toBe(404);
    const audit = (await (await api('/api/audit?limit=200')).json()) as {
      items: Array<{ action: string; data: { why: string } }>;
    };
    const refusals = audit.items.filter((e) => e.action === 'request.decision_refused');
    expect(refusals.map((e) => e.data.why)).toEqual(
      expect.arrayContaining([
        'You can’t decide your own request.',
        'The policy doesn’t name you as an approver for this step.',
      ]),
    );
  });

  it('Dana approves; the grant adds Tal to the group, wakes the flow, and sends grant.activated', async () => {
    const danas = as(people.Dana!);
    const page = AccessRequestView.parse(await (await danas(`/api/access/requests/${request.ref}`)).json());
    expect(page.actions.decide).toBe(true);
    const decided = await danas(
      `/api/access/requests/${request.id}/decision`,
      json({ outcome: 'approve', comment: 'ok' }),
    );
    await expectStatus(decided, 200);
    request = AccessRequestView.parse(await decided.json());
    expect(request).toMatchObject({ status: 'approved', method: 'reviewed' });
    expect(request.grant).toMatchObject({ status: 'active' });
    expect(request.grant!.targets.map((t) => [t.key, t.managedBy, t.status])).toEqual([
      [`group:${editors.id}`, 'landbright', 'provisioned'],
      ['landflow:payments-editor', 'flow', 'pending'],
    ]);
    // A second vote is refused.
    expect((await danas(`/api/access/requests/${request.id}/decision`, json({ outcome: 'deny' }))).status).toBe(403);

    const group = GroupDetail.parse(await (await api(`/api/groups/${editors.id}`)).json());
    expect(group.members.find((m) => m.id === tal.id)).toMatchObject({ source: 'grant' });

    await until(() => received.some((r) => r.path === '/resume/exec-1'));
    const activated = await until(() => events('grant.activated')[0]);
    expect(
      activated.data.grant.targets.find((t: { key: string }) => t.key === 'landflow:payments-editor').config,
    ).toEqual({
      project: 'payments',
      role: 'editor',
    });
    await until(() => events('request.decided').find((e) => e.data.outcome === 'approved'));
  });

  it('takes the flow’s target reports, and refuses one for a target Landbright manages', async () => {
    const grantId = request.grant!.id;
    const ok = await machine(
      `/api/v1/grants/${grantId}/targets/landflow:payments-editor`,
      json({ status: 'provisioned', externalRef: 'payments/editor/tal' }),
    );
    await expectStatus(ok, 200);
    const own = await machine(`/api/v1/grants/${grantId}/targets/group:${editors.id}`, json({ status: 'revoked' }));
    await expectStatus(own, 403);
    const list = (await (await machine('/api/v1/grants?status=active&type=landflow-project-role')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(list.items.map((g) => g.id)).toContain(grantId);
  });

  it('at expiry the sweeper removes the membership, says grant.expired, and refuses a late "provisioned"', async () => {
    await until(() => events('grant.expiring')[0], 30_000);
    await until(() => events('grant.expired')[0], 75_000);
    const group = GroupDetail.parse(await (await api(`/api/groups/${editors.id}`)).json());
    expect(group.members.some((m) => m.id === tal.id)).toBe(false);
    await until(() => events('group.member_removed').find((e) => e.data.identityId === tal.id));

    const grantId = request.grant!.id;
    const late = await machine(
      `/api/v1/grants/${grantId}/targets/landflow:payments-editor`,
      json({ status: 'provisioned' }),
    );
    await expectStatus(late, 409);
    const revoked = await machine(
      `/api/v1/grants/${grantId}/targets/landflow:payments-editor`,
      json({ status: 'revoked' }),
    );
    await expectStatus(revoked, 200);
  }, 120_000);

  it('a leaver loses their grant at once', async () => {
    const tals = as(people.Tal!);
    const again = AccessRequestView.parse(
      await (
        await tals(
          '/api/access/requests',
          json({ bundleId: bundle.id, durationMinutes: 60, reason: 'Second round of fixes' }),
        )
      ).json(),
    );
    await as(people.Dana!)(`/api/access/requests/${again.id}/decision`, json({ outcome: 'approve' }));
    const off = await machine(`/api/v1/people/${tal.id}/deactivate`, json({ reason: 'Left the company (HR)' }));
    await expectStatus(off, 200);
    const after = AccessRequestView.parse(await (await api(`/api/access/requests/${again.ref}`)).json());
    expect(after.grant).toMatchObject({ status: 'revoked', closingReason: 'leaver' });
    const group = GroupDetail.parse(await (await api(`/api/groups/${editors.id}`)).json());
    expect(group.members.some((m) => m.id === tal.id)).toBe(false);
  });

  it('finds people who haven’t signed in, for a lifecycle flow', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const list = (await (await machine(`/api/v1/people?inactiveSince=${tomorrow}`)).json()) as {
      items: Array<{ id: string; lastSignInAt: string | null }>;
    };
    const danaRow = list.items.find((p) => p.id === dana.id);
    expect(danaRow?.lastSignInAt).toBeTruthy();
    expect(list.items.some((p) => p.id === tal.id)).toBe(false); // deactivated
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const none = (await (await machine(`/api/v1/people?inactiveSince=${yesterday}`)).json()) as { items: unknown[] };
    expect(none.items).toHaveLength(0);
  });

  it('shows the deliveries, each answered by the flow', async () => {
    const subs = (await (await api('/api/events/subscriptions')).json()) as { items: Subscription[] };
    const deliveries = (await (await api(`/api/events/subscriptions/${subs.items[0]!.id}/deliveries`)).json()) as {
      items: Array<{ status: string; response: { executionId?: string } | null }>;
    };
    expect(deliveries.items.length).toBeGreaterThan(5);
    expect(deliveries.items.every((d) => d.status !== 'failed')).toBe(true);
    expect(deliveries.items.find((d) => d.status === 'delivered')?.response?.executionId).toMatch(/^exec-/);
  });
});
