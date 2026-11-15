import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ApplicationWithSecret,
  AuditPage,
  BirthrightResult,
  GroupRef,
  Person,
  Settings,
  UpsertWorkerResult,
} from '@landbright/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

// The plugins are loaded at run time, as in hr-joiner.test.ts: these are the shapes this test uses.
type Json = Record<string, unknown>;
interface NodeRun {
  outputs: Array<Array<{ json: Json }>>;
  error?: { message: string };
}
interface WebhookRun {
  items?: Array<{ json: Json }>;
  response?: { status?: number };
  idempotencyKey?: string;
  error?: { message: string };
}
interface MethodRun {
  staticData?: Json;
  exists?: boolean;
  error?: { message: string };
}
interface FakeHiBob {
  employees: Map<string, Json>;
  close(): Promise<void>;
}
interface Plugins {
  HiBobTrigger: unknown;
  call(node: unknown, parameters: Json, credentials: Json, body: Json): Promise<WebhookRun>;
  credentials(fake: FakeHiBob): Json;
  bobEvent(type: string, employeeId: string, extra?: Json): Json;
  startFakeHiBob(): Promise<FakeHiBob>;
  runLandbright(parameters: Json, items: Json[], credentials: Json): Promise<NodeRun>;
  runTriggerMethod(
    name: 'checkExists' | 'create' | 'delete',
    parameters: Json,
    credentials: Json,
    webhookUrl: string,
    staticData?: Json,
  ): Promise<MethodRun>;
  runTriggerWebhook(
    parameters: Json,
    credentials: Json,
    webhookUrl: string,
    staticData: Json,
    headers: Record<string, string>,
    rawBody: Buffer,
  ): Promise<WebhookRun>;
}
const PLUGINS = resolve(import.meta.dirname, '../../integrations/landflow/plugins');
const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(resolve(PLUGINS, path)).href) as Promise<Json>;
async function loadPlugins(): Promise<Plugins> {
  const parts = await Promise.all([
    load('hris/src/nodes/hibob-trigger.ts'),
    load('hris/test/fake-hibob.ts'),
    load('hris/test/helpers.ts'),
    load('landbright/test/helpers.ts'),
  ]);
  return Object.assign({}, ...parts) as Plugins;
}

/** The date it is in a zone (what Landbright compares start and last days with). */
const localDate = (zone: string, offsetDays = 0) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

/**
 * Spec 007, slice 2: movers and leavers from HiBob, start and last days in the site's zone, and the Landbright Trigger
 * subscribing itself and checking Landbright's tokens, all against the built stack. The two zones are the furthest
 * ahead of UTC and the furthest behind, so whatever the hour, a date that has begun in one hasn't in the other.
 */
describe.skipIf(!e2eEnabled)('movers and leavers from HiBob, end to end', () => {
  let stack: Stack;
  let bob: FakeHiBob;
  let p: Plugins;
  const admin = new Browser();
  let landbrightApi: Json;
  let appId: string;
  const EAST = { site: 'Kiritimati', zone: 'Pacific/Kiritimati' };
  const WEST = { site: 'Pago Pago', zone: 'Pacific/Pago_Pago' };

  const api = (path: string, init: RequestInit = {}) =>
    admin.fetch(`${stack.control}${path}`, {
      ...init,
      headers: { origin: stack.control, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  const person = async (id: string) => Person.parse(await (await api(`/api/people/${id}`)).json());

  async function until<T>(check: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** A worker straight to the Landbright node, Person → Create or Update. */
  async function upsert(worker: Json) {
    const run = await p.runLandbright({ resource: 'person', operation: 'upsert' }, [worker], landbrightApi);
    expect(run.error).toBeUndefined();
    return UpsertWorkerResult.parse(run.outputs[0]![0]!.json);
  }
  let n = 0;
  const worker = (values: Json = {}) => {
    n += 1;
    return {
      source: 'hibob',
      sourceId: `e2e-${n}`,
      email: `w${n}@${stack.slug}.test`,
      givenName: `Worker${n}`,
      familyName: 'Test',
      ...values,
    };
  };

  beforeAll(async () => {
    p = await loadPlugins();
    stack = await startStack();
    bob = await p.startFakeHiBob();
    const page = await admin.navigate(`${stack.control}/api/auth/login?returnTo=/`);
    let after = await admin.submit(page.url, formAction(await page.response.text()), stack.admin);
    const skip = /action="([^"]+\/totp\/skip)"/.exec(await after.response.text())?.[1];
    if (skip) after = await admin.submit(after.url, skip, {});
    const created = await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({
        name: 'HR flows (e2e)',
        clientId: `hr2-${stack.slug}`,
        // The Landbright Trigger may subscribe only at this origin (the receiver below listens there).
        redirectUris: ['http://127.0.0.1:9/callback'],
        grantTypes: ['client_credentials'],
        apiScopes: ['directory:read', 'directory:write', 'events:manage'],
      }),
    });
    expect(created.status).toBe(201);
    const app = ApplicationWithSecret.parse(await created.json());
    landbrightApi = {
      controlUrl: stack.control,
      issuer: stack.issuer,
      clientId: app.application.clientId,
      clientSecret: app.clientSecret,
      scopes: 'directory:read directory:write events:manage',
    };
    appId = app.application.id;
  }, 180_000);
  afterAll(async () => {
    await stack?.stop();
    await bob?.close();
  });

  it('keeps the zones: a default and one per site; an unknown zone is refused', async () => {
    const bad = await api('/api/settings/people', {
      method: 'PATCH',
      body: JSON.stringify({ timeZone: 'Mars/Olympus', siteTimeZones: {} }),
    });
    expect(bad.status).toBe(400);
    const saved = await api('/api/settings/people', {
      method: 'PATCH',
      body: JSON.stringify({ timeZone: 'UTC', siteTimeZones: { [EAST.site]: EAST.zone, [WEST.site]: WEST.zone } }),
    });
    expect(saved.status).toBe(200);
    expect(Settings.parse(await saved.json()).people).toEqual({
      timeZone: 'UTC',
      siteTimeZones: { [EAST.site]: EAST.zone, [WEST.site]: WEST.zone },
    });
  });

  it("starts people on their start date in their site's zone", async () => {
    // Today where they are: active at once. Tomorrow where they are: a pre-hire, whatever the date in UTC.
    for (const { site, zone } of [EAST, WEST]) {
      expect((await upsert(worker({ site, startDate: localDate(zone) }))).person.status).toBe('active');
      expect((await upsert(worker({ site, startDate: localDate(zone, 1) }))).person.status).toBe('pre_hire');
    }
    // The worker, too: a pre-hire whose start date is moved to today where they are is activated on its next pass.
    const later = (await upsert(worker({ site: EAST.site, startDate: localDate(EAST.zone, 3) }))).person;
    const moved = await api(`/api/people/${later.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ startDate: localDate(EAST.zone) }),
    });
    expect(moved.status).toBe(200);
    await until(async () => (await person(later.id)).status === 'active');
  });

  it("deactivates people when their last day ends in their zone, not before; HR's termination date sets it", async () => {
    // Bob has their termination date; the update reaches Landbright through the HiBob Trigger and the upsert.
    const id = '3332883884017713239';
    Object.assign(bob.employees.get(id)!, {
      email: `omer@${stack.slug}.test`,
      site: EAST.site,
      startDate: '2025-01-05',
      terminationDate: localDate(EAST.zone, -1),
    });
    const delivered = await p.call(p.HiBobTrigger, { fetchEmployee: true }, p.credentials(bob), {
      ...p.bobEvent('employee.updated', id, { fieldUpdatesIds: ['internal.terminationDate'] }),
    });
    expect(delivered.error).toBeUndefined();
    const leaver = (await upsert(delivered.items![0]!.json)).person;
    expect(leaver).toMatchObject({ status: 'active', endDate: localDate(EAST.zone, -1), site: EAST.site });
    // Their last day is today where they are: they keep their access until it ends.
    const today = (await upsert(worker({ site: WEST.site, endDate: localDate(WEST.zone) }))).person;

    await until(async () => (await person(leaver.id)).status === 'deactivated');
    const audit = AuditPage.parse(await (await api('/api/audit?limit=100')).json());
    expect(audit.items.find((e) => e.action === 'identity.deactivated' && e.targetId === leaver.id)).toMatchObject({
      actorLabel: 'End dates',
      data: expect.objectContaining({ reason: `Their last day (${localDate(EAST.zone, -1)}) ended` }),
    });
    expect((await person(today.id)).status).toBe('active');
    // HR told Landbright after their last day: they were created, but no invite went.
    const mail = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${leaver.email}"`)}`)
    ).json()) as { messages: unknown[] };
    expect(mail.messages).toHaveLength(0);
  });

  it("moves a mover's birthright groups and leaves the rest of their memberships alone", async () => {
    const group = async (name: string) => {
      const res = await api('/api/groups', { method: 'POST', body: JSON.stringify({ name, kind: 'birthright' }) });
      expect(res.status).toBe(201);
      return GroupRef.parse(await res.json());
    };
    await group('Everyone');
    await group('Engineers');
    await group('Finance');
    const byHand = await group('Release managers');
    const mover = (await upsert(worker({ department: 'Engineering' }))).person;
    const set = (groups: string[]) =>
      p.runLandbright(
        { resource: 'person', operation: 'setBirthright', personId: mover.id, groups: groups.join('\n') },
        [{}],
        landbrightApi,
      );
    const first = BirthrightResult.parse((await set(['Everyone', 'Engineers', 'Ghosts'])).outputs[0]![0]!.json);
    expect(first).toMatchObject({ added: ['Everyone', 'Engineers'], removed: [], missing: ['Ghosts'] });
    expect(
      (
        await api(`/api/groups/${byHand.id}/members`, {
          method: 'POST',
          body: JSON.stringify({ identityId: mover.id }),
        })
      ).status,
    ).toBeLessThan(300);

    // They move to Finance: the Onboard flow's map gives Everyone and Finance.
    const moved = await upsert(
      worker({ ...mover.sources[0], email: mover.email, givenName: mover.givenName, department: 'Finance' }),
    );
    expect(moved.changed).toEqual(['department']);
    const second = BirthrightResult.parse((await set(['Everyone', 'Finance'])).outputs[0]![0]!.json);
    expect(second).toMatchObject({ added: ['Finance'], removed: ['Engineers'], missing: [] });
    expect(second.person.groups.map((g) => g.name).sort()).toEqual(['Everyone', 'Finance', 'Release managers']);
    // Again: nothing to do.
    expect(BirthrightResult.parse((await set(['Everyone', 'Finance'])).outputs[0]![0]!.json)).toMatchObject({
      added: [],
      removed: [],
    });
    const admins = await set(['Landbright Admins']);
    expect(admins.error?.message).toMatch(/403/);
  });

  it('deactivates a leaver from HiBob, found by their HiBob id; someone Landbright lacks is skipped', async () => {
    const leaver = (await upsert(worker())).person;
    const sourceId = leaver.sources[0]!.sourceId;
    // The Leaver flow's trigger doesn't read Bob: the event is enough.
    const item = { source: 'hibob', sourceId, event: 'employee.access.revoked.immediately' };
    const run = await p.runLandbright(
      {
        resource: 'person',
        operation: 'deactivate',
        findBy: 'source',
        notFound: 'skip',
        reason: 'HiBob: employee.access.revoked.immediately',
      },
      [item, { source: 'hibob', sourceId: 'nobody-here', event: 'employee.left' }],
      landbrightApi,
    );
    expect(run.error).toBeUndefined();
    expect(run.outputs[0]!.map((o) => o.json)).toEqual([{ id: leaver.id, status: 'deactivated' }]);
    const audit = AuditPage.parse(await (await api('/api/audit?limit=50')).json());
    expect(audit.items.find((e) => e.action === 'identity.deactivated' && e.targetId === leaver.id)).toMatchObject({
      actorLabel: 'HR flows (e2e) (service)',
      data: expect.objectContaining({ reason: 'HiBob: employee.access.revoked.immediately' }),
    });
  });

  it("the Landbright Trigger subscribes itself, takes Landbright's signed events, and unsubscribes", async () => {
    // A stand-in for Landflow's app webhook: what arrives is handed to the trigger as Landflow would hand it.
    const received: Array<{ headers: Record<string, string>; body: Buffer }> = [];
    const server: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      received.push({ headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const webhookUrl = `http://127.0.0.1:${port}/api/webhook/app/wf_test/n1`;
    try {
      // Its origin must be one of the application's redirect URIs.
      expect(
        (
          await api(`/api/applications/${appId}`, {
            method: 'PATCH',
            body: JSON.stringify({ redirectUris: [`http://127.0.0.1:${port}/callback`] }),
          })
        ).status,
      ).toBe(200);
      const parameters = { events: 'identity.deactivated' };
      const created = await p.runTriggerMethod('create', parameters, landbrightApi, webhookUrl);
      expect(created.error).toBeUndefined();
      const data = created.staticData!;
      expect((await p.runTriggerMethod('checkExists', parameters, landbrightApi, webhookUrl, data)).exists).toBe(true);

      const someone = (await upsert(worker())).person;
      expect((await api(`/api/people/${someone.id}/deactivate`, { method: 'POST' })).status).toBe(200);
      const delivery = await until(async () =>
        received.find((r) => r.headers.authorization && r.body.toString().includes(someone.id)),
      );
      const run = await p.runTriggerWebhook(
        parameters,
        landbrightApi,
        webhookUrl,
        data,
        delivery.headers,
        delivery.body,
      );
      expect(run.error).toBeUndefined();
      expect(run.response?.status).toBe(200);
      expect(run.items?.[0]?.json).toMatchObject({ type: 'identity.deactivated', target: { id: someone.id } });
      expect(run.idempotencyKey).toBe(delivery.headers['idempotency-key']);
      // The same body with a token not from Landbright starts nothing.
      const forged = await p.runTriggerWebhook(
        parameters,
        landbrightApi,
        webhookUrl,
        data,
        {
          ...delivery.headers,
          authorization: `Bearer ${delivery.headers.authorization!.split(' ')[1]!.slice(0, -4)}AAAA`,
        },
        delivery.body,
      );
      expect(forged.response?.status).toBe(401);

      expect((await p.runTriggerMethod('delete', parameters, landbrightApi, webhookUrl, data)).error).toBeUndefined();
      expect((await p.runTriggerMethod('checkExists', parameters, landbrightApi, webhookUrl, data)).exists).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
