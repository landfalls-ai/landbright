import { Bundle, GroupDetail, Person, ScimTargetDetail, ScimTestResult } from '@landbright/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { FakeScim } from './fake-scim';
import { e2eEnabled, type Stack, startStack } from './stack';

/**
 * Provisioning out (spec 006) end to end: the built services push to two fake SCIM servers shaped like the real ones
 * (fake-scim.ts): a Landflow-like one (groups stored, 409s, sessions ended by `active: false`) and a Landfall-like one
 * (create-or-link, a role from the person's groups, no Groups). Changes reach them through the worker's loop (2 s).
 */
describe.skipIf(!e2eEnabled)('provisioning end to end', () => {
  let stack: Stack;
  const admin = new Browser();
  const landflow = new FakeScim('landflow');
  const landfall = new FakeScim('landfall');
  const people: Record<string, Person> = {};
  let data: GroupDetail;
  let admins: GroupDetail;
  let staff: GroupDetail;
  let target: ScimTargetDetail;
  let adminId: string;

  const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) });
  const api = (path: string, init: RequestInit = {}) =>
    admin.fetch(`${stack.control}${path}`, {
      ...init,
      headers: { origin: stack.control, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  async function ok<T>(response: Response, status = 200): Promise<T> {
    if (response.status !== status) expect(`${response.status} ${await response.clone().text()}`).toBe(String(status));
    return (status === 204 ? undefined : await response.json()) as T;
  }
  /** Polls until `check` holds (the worker runs every 2 seconds); answers how long it took. */
  async function eventually(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await check()) return Date.now() - start;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`not within ${ms / 1000} s: ${what}`);
  }
  const detail = async (id = target.id) =>
    ScimTargetDetail.parse(await ok(await api(`/api/provisioning/targets/${id}`)));
  const addPerson = async (givenName: string, groupIds: string[]) => {
    const person = Person.parse(
      await ok(
        await api(
          '/api/people',
          json({ email: `${givenName.toLowerCase()}@${stack.slug}.test`, givenName, familyName: 'Test' }),
        ),
        201,
      ),
    );
    for (const g of groupIds) await ok(await api(`/api/groups/${g}/members`, json({ identityId: person.id })), 201);
    people[givenName] = person;
    return person;
  };
  const emailOf = (name: string) => people[name]!.email!;

  beforeAll(async () => {
    await landflow.start();
    await landfall.start();
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
    adminId = ((await ok(await api('/api/auth/me'))) as { id: string }).id;
  }, 180_000);
  afterAll(async () => {
    await stack?.stop();
    await landflow.stop();
    await landfall.stop();
  });

  it('sets up groups and people; one already has an account in Landflow from signing in', async () => {
    data = GroupDetail.parse(await ok(await api('/api/groups', json({ name: 'Data Team', kind: 'jit' })), 201));
    admins = GroupDetail.parse(await ok(await api('/api/groups', json({ name: 'Landflow Admins' })), 201));
    staff = GroupDetail.parse(await ok(await api('/api/groups', json({ name: 'Staff' })), 201));
    await addPerson('Maya', [data.id]);
    await addPerson('Tal', [admins.id]);
    await addPerson('Lior', []); // in no assigned group: never pushed
    const existing = landflow.seedUser(emailOf('Tal'), { displayName: 'Tal (signed in once)' });
    landflow.signIn(existing);
  });

  it('a target pushes its people and groups, adopting the account already there', async () => {
    target = ScimTargetDetail.parse(
      await ok(
        await api(
          '/api/provisioning/targets',
          json({
            name: 'Landflow (fake)',
            baseUrl: `${landflow.url}/`,
            token: landflow.token,
            groupIds: [data.id, admins.id],
          }),
        ),
        201,
      ),
    );
    expect(target.baseUrl).toBe(landflow.url);
    expect(target).not.toHaveProperty('token');
    expect(JSON.stringify(target)).not.toContain(landflow.token);

    await eventually(() => landflow.groups.size === 2 && !!landflow.byUserName(emailOf('Maya')), 'pushed');
    const maya = landflow.byUserName(emailOf('Maya'))!;
    expect(maya).toMatchObject({ externalId: people.Maya!.id, displayName: 'Maya Test', active: true });
    const tal = landflow.byUserName(emailOf('Tal'))!;
    expect(tal.externalId).toBe(people.Tal!.id); // adopted on 409, not duplicated
    expect([...landflow.users.values()].filter((u) => u.userName === emailOf('Tal'))).toHaveLength(1);
    expect(landflow.byUserName(emailOf('Lior'))).toBeUndefined();
    await eventually(
      () => landflow.byGroupName('Data Team')?.members.includes(maya.id) === true,
      'Maya in Data Team there',
    );
    expect(landflow.byGroupName('Landflow Admins')!.members).toEqual([tal.id]);
    expect(landflow.byGroupName('Data Team')!.externalId).toBe(data.id);

    await eventually(async () => (await detail()).state === 'in_sync', 'in sync');
    const now = await detail();
    expect(now.counts).toEqual({ active: 2, inactive: 0, groups: 2 });
    expect(now.links.find((l) => l.localId === people.Tal!.id)?.remoteId).toBe(tal.id);
    const audit = (await ok(await api('/api/audit?limit=100'))) as {
      items: Array<{ action: string; targetId: string }>;
    };
    expect(audit.items.some((e) => e.action === 'provisioning.user_linked' && e.targetId === people.Tal!.id)).toBe(
      true,
    );
    expect(audit.items.some((e) => e.action === 'provisioning.user_created' && e.targetId === people.Maya!.id)).toBe(
      true,
    );
  });

  it('Test says whether the server takes the token', async () => {
    const good = ScimTestResult.parse(await ok(await api(`/api/provisioning/targets/${target.id}/test`, json({}))));
    expect(good).toMatchObject({ ok: true, status: 200, patch: true, filter: true });
    const other = ScimTargetDetail.parse(
      await ok(
        await api(
          '/api/provisioning/targets',
          json({ name: 'Wrong token', baseUrl: landflow.url, token: 'not-the-token', disabled: true }),
        ),
        201,
      ),
    );
    const bad = ScimTestResult.parse(await ok(await api(`/api/provisioning/targets/${other.id}/test`, json({}))));
    expect(bad).toMatchObject({ ok: false, status: 401, detail: 'The server refused the token.' });
    await ok(await api(`/api/provisioning/targets/${other.id}`, { method: 'DELETE' }), 204);
  });

  it('deactivating a person signs them out of the application within seconds', async () => {
    const tal = landflow.byUserName(emailOf('Tal'))!;
    expect(landflow.sessions.has(tal.id)).toBe(true);
    await ok(await api(`/api/people/${people.Tal!.id}/deactivate`, json({ reason: 'Left the company' })));
    const took = await eventually(() => !landflow.sessions.has(tal.id), 'Tal signed out there', 10_000);
    expect(took).toBeLessThan(6_000);
    expect(tal.active).toBe(false);
    await eventually(() => landflow.byGroupName('Landflow Admins')!.members.length === 0, 'out of Landflow Admins');
    const audit = (await ok(await api('/api/audit?limit=50'))) as {
      items: Array<{ action: string; targetId: string; data: Record<string, unknown> }>;
    };
    expect(
      audit.items.find((e) => e.action === 'provisioning.user_deactivated' && e.targetId === people.Tal!.id)?.data,
    ).toMatchObject({ why: 'deactivated', target: 'Landflow (fake)' });
  });

  it('reactivating them makes them active there again, in their groups', async () => {
    await ok(await api(`/api/people/${people.Tal!.id}/reactivate`, json({})));
    const tal = landflow.byUserName(emailOf('Tal'))!;
    await eventually(() => tal.active, 'Tal active there');
    await eventually(() => landflow.byGroupName('Landflow Admins')!.members.includes(tal.id), 'back in Admins');
  });

  it('leaving every assigned group makes a person inactive there; renaming a person reaches it', async () => {
    await ok(await api(`/api/groups/${admins.id}/members/${people.Tal!.id}`, { method: 'DELETE' }));
    await eventually(() => landflow.byUserName(emailOf('Tal'))!.active === false, 'Tal inactive there');
    await ok(await api(`/api/people/${people.Maya!.id}`, json({ givenName: 'Maya', familyName: 'Levi' }, 'PATCH')));
    await eventually(() => landflow.byUserName(emailOf('Maya'))!.displayName === 'Maya Levi', 'renamed there');
  });

  it('a just-in-time grant puts its group there, and its end takes it away', async () => {
    await ok(await api(`/api/groups/${staff.id}/members`, json({ identityId: adminId })), 201);
    const bundle = Bundle.parse(
      await ok(
        await api(
          '/api/bundles',
          json({
            name: 'Data Team (2 hours)',
            ownerId: adminId,
            groupIds: [data.id],
            policy: {
              steps: [{ name: 'Admins', approvers: { groupIds: [admins.id] }, approvalsRequired: 1 }],
              autoApprove: [{ name: 'Staff', subjectInGroupIds: [staff.id] }],
              maxDurationMinutes: 120,
            },
          }),
        ),
        201,
      ),
    );
    await ok(
      await api(
        '/api/access/requests',
        json({ bundleId: bundle.id, durationMinutes: 120, reason: 'Quarterly numbers' }),
      ),
      201,
    );
    const me = await eventually(() => !!landflow.byUserName(stack.admin.email), 'the admin pushed');
    expect(me).toBeGreaterThanOrEqual(0);
    const remote = landflow.byUserName(stack.admin.email)!;
    await eventually(() => landflow.byGroupName('Data Team')!.members.includes(remote.id), 'in Data Team there');
    const audit = (await ok(await api('/api/audit?limit=50'))) as {
      items: Array<{ action: string; targetId: string; data: Record<string, unknown> }>;
    };
    const grants = (await ok(await api('/api/access/grants?status=active'))) as {
      items: Array<{ id: string; subject: { id: string } }>;
    };
    const grant = grants.items.find((g) => g.subject.id === adminId)!;
    expect(
      audit.items.some(
        (e) =>
          e.action === 'provisioning.group_updated' &&
          (e.data.grants as Array<{ grantId: string }> | undefined)?.some((g) => g.grantId === grant.id),
      ),
    ).toBe(true);

    await ok(await api(`/api/access/grants/${grant.id}/revoke`, json({ comment: 'Done' })));
    await eventually(() => !landflow.byGroupName('Data Team')!.members.includes(remote.id), 'out of Data Team');
    const after = (await ok(await api('/api/audit?limit=30'))) as {
      items: Array<{ action: string; targetId: string; data: Record<string, unknown> }>;
    };
    // Who left, as Landbright ids.
    expect(
      after.items.find((e) => e.action === 'provisioning.group_updated' && e.targetId === data.id)?.data.removed,
    ).toEqual([adminId]);
    // Staff isn't assigned and Data Team was the admin's only assigned group: inactive there.
    await eventually(() => remote.active === false, 'the admin inactive there');
  });

  it('renames and unassigned groups follow; a failing server is retried until it lands', async () => {
    await ok(await api(`/api/groups/${data.id}`, json({ name: 'Data' }, 'PATCH')));
    await eventually(() => !!landflow.byGroupName('Data'), 'renamed there');

    landflow.failNext(503, 503);
    await ok(await api(`/api/provisioning/targets/${target.id}`, json({ groupIds: [admins.id] }, 'PATCH')));
    await eventually(async () => (await detail()).state === 'failing', 'failing shown');
    const failing = await detail();
    expect(failing.lastError).toContain('503 Failing as asked');
    await eventually(() => !landflow.byGroupName('Data'), 'Data deleted there', 30_000);
    await eventually(() => landflow.byUserName(emailOf('Maya'))!.active === false, 'Maya out of scope there');
    await eventually(async () => (await detail()).state === 'in_sync', 'in sync again', 30_000);
  });

  it('reconciliation puts back what was changed by hand there', async () => {
    const maya = landflow.byUserName(emailOf('Maya'))!;
    maya.active = true; // someone reactivated her in the application
    await ok(await api(`/api/provisioning/targets/${target.id}/sync`, json({})));
    await eventually(() => maya.active === false, 'set inactive again');
    const audit = (await ok(await api('/api/audit?limit=30'))) as {
      items: Array<{ action: string; targetId: string; data: Record<string, unknown> }>;
    };
    expect(
      audit.items.find((e) => e.action === 'provisioning.user_deactivated' && e.targetId === people.Maya!.id)?.data,
    ).toMatchObject({ drift: true });
  });

  it('a Landfall-like server gets each person’s groups on the person, and no Groups', async () => {
    await ok(await api(`/api/groups/${admins.id}/members`, json({ identityId: people.Maya!.id })), 201);
    const fall = ScimTargetDetail.parse(
      await ok(
        await api(
          '/api/provisioning/targets',
          json({
            name: 'Landfall (fake)',
            baseUrl: landfall.url,
            token: landfall.token,
            groupsMode: 'user_attribute',
            groupIds: [admins.id, data.id],
          }),
        ),
        201,
      ),
    );
    await eventually(() => landfall.byUserName(emailOf('Maya'))?.role === 'admin', 'Maya admin there');
    const maya = landfall.byUserName(emailOf('Maya'))!;
    expect(maya.externalId).toBe(people.Maya!.id); // the ID token's sub: Landfall links her sign-in with it
    expect(landfall.calls.some((c) => c.path.startsWith('/Groups'))).toBe(false);

    await ok(await api(`/api/groups/${admins.id}/members/${people.Maya!.id}`, { method: 'DELETE' }));
    // Still in Data (since the start): her role follows her groups down.
    await eventually(() => maya.role === 'responder', 'her role follows her groups');

    await ok(await api(`/api/people/${people.Maya!.id}/deactivate`, json({})));
    await eventually(() => maya.active === false, 'deactivated there');
    await ok(await api(`/api/people/${people.Maya!.id}/reactivate`, json({})));
    await eventually(() => maya.active, 'active there again');
    // Reactivated by creating her again: Landfall re-links her sign-in only on create.
    expect(
      landfall.calls.filter(
        (c) => c.method === 'POST' && (c.body as { userName?: string }).userName === emailOf('Maya'),
      ).length,
    ).toBeGreaterThanOrEqual(2);
    await eventually(async () => (await detail(fall.id)).state === 'in_sync', 'Landfall in sync');
  });

  it('only administrators manage targets, and deleting one leaves the application as it is', async () => {
    expect((await fetch(`${stack.control}/api/provisioning/targets`)).status).toBe(401);
    const before = landflow.users.size;
    await ok(await api(`/api/provisioning/targets/${target.id}`, { method: 'DELETE' }), 204);
    expect(landflow.users.size).toBe(before);
    expect((await api(`/api/provisioning/targets/${target.id}`)).status).toBe(404);
  });
});
