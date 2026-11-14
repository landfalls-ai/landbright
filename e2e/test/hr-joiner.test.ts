import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApplicationWithSecret, AuditPage, Person, UpsertWorkerResult } from '@landbright/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, formAction } from './browser';
import { e2eEnabled, MAILPIT, type Stack, startStack } from './stack';

// The plugins (integrations/landflow/plugins) are loaded at run time: they are typechecked and tested on their own,
// against Landflow's SDK, which this package doesn't build against. These are the shapes the test uses.
type Json = Record<string, unknown>;
interface NodeRun {
  outputs: Array<Array<{ json: Json }>>;
  error?: { message: string };
}
interface WebhookRun {
  items?: Array<{ json: Json }>;
  response?: { status?: number };
  error?: { message: string };
}
interface FakeHiBob {
  employees: Map<string, Json>;
  close(): Promise<void>;
}
interface Plugins {
  HiBobTrigger: unknown;
  call(
    node: unknown,
    parameters: Json,
    credentials: Json,
    body: Json,
    signature?: boolean | string,
  ): Promise<WebhookRun>;
  credentials(fake: FakeHiBob): Json;
  bobEvent(type: string, employeeId: string, extra?: Json): Json;
  startFakeHiBob(): Promise<FakeHiBob>;
  runLandbright(parameters: Json, items: Json[], credentials: Json): Promise<NodeRun>;
}
const PLUGINS = resolve(import.meta.dirname, '../../integrations/landflow/plugins');
const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(resolve(PLUGINS, path)).href) as Promise<Json>;
async function loadPlugins(): Promise<Plugins> {
  const [trigger, fake, hris, landbright] = await Promise.all([
    load('hris/src/nodes/hibob-trigger.ts'),
    load('hris/test/fake-hibob.ts'),
    load('hris/test/helpers.ts'),
    load('landbright/test/helpers.ts'),
  ]);
  return { ...trigger, ...fake, ...hris, ...landbright } as unknown as Plugins;
}

/**
 * Spec 007, slice 1: a joiner from HiBob. The hris plugin's HiBob Trigger takes a delivery signed as Bob signs it and
 * reads the employee from a fake Bob; the landbright plugin's Landbright node creates them in the built stack. They
 * are a pre-hire until their start date: no invite, no sign-in. Bob's `employee.joined` (or the start date coming)
 * makes them active, and the invite goes.
 *
 * The nodes run here as Landflow runs them (the SDK's runWebhook and runNode, the same requests); the live check runs
 * them inside the throwaway Landflow.
 */
describe.skipIf(!e2eEnabled)('a joiner from HiBob, end to end', () => {
  let stack: Stack;
  let bob: FakeHiBob;
  let p: Plugins;
  const admin = new Browser();
  let landbrightApi: Json;
  const NOA = '3332883884017713238';
  const RAFI = '3332883884017719000';
  let noa: Person;

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const api = (path: string, init: RequestInit = {}) =>
    admin.fetch(`${stack.control}${path}`, {
      ...init,
      headers: { origin: stack.control, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });

  async function until<T>(check: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const invites = async (email: string) =>
    (
      (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as {
        messages: unknown[];
      }
    ).messages.length;

  /** Bob's delivery through the HiBob Trigger: the item it starts a run with. */
  async function deliver(type: string, employeeId: string, extra: Json = {}) {
    const response = await p.call(
      p.HiBobTrigger,
      { fetchEmployee: true },
      p.credentials(bob),
      p.bobEvent(type, employeeId, extra),
    );
    expect(response.error).toBeUndefined();
    expect(response.items).toHaveLength(1);
    return response.items![0]!.json;
  }

  /** The Landbright node, Person → Create or Update, with the worker as its input item. */
  const upsert = (worker: Json) =>
    p.runLandbright({ resource: 'person', operation: 'upsert' }, [worker], landbrightApi);
  const resultOf = (response: NodeRun) => {
    expect(response.error).toBeUndefined();
    return UpsertWorkerResult.parse(response.outputs[0]![0]!.json);
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
        clientId: `hr-${stack.slug}`,
        redirectUris: ['http://127.0.0.1:9/callback'],
        grantTypes: ['client_credentials'],
        apiScopes: ['directory:read', 'directory:write'],
      }),
    });
    expect(created.status).toBe(201);
    const app = ApplicationWithSecret.parse(await created.json());
    landbrightApi = {
      controlUrl: stack.control,
      issuer: stack.issuer,
      clientId: app.application.clientId,
      clientSecret: app.clientSecret,
    };
    const people = (domain: string) => ({
      [NOA]: { email: `noa@${domain}`, managerEmail: stack.admin.email, startDate: day(7) },
      [RAFI]: {
        id: RAFI,
        email: `rafi@${domain}`,
        firstName: 'Rafi',
        surname: 'Golan',
        department: 'Finance',
        title: 'Analyst',
        site: 'London',
        startDate: day(1),
        lifecycleStatus: 'hired',
      },
    });
    for (const [id, values] of Object.entries(people(`${stack.slug}.test`)))
      bob.employees.set(id, { ...bob.employees.get(id), ...values });
  }, 180_000);
  afterAll(async () => {
    await stack?.stop();
    await bob?.close();
  });

  it('creates a pre-hire from a signed employee.created: profile, manager, source; no invite yet', async () => {
    const worker = await deliver('employee.created', NOA);
    expect(worker).toMatchObject({
      source: 'hibob',
      sourceId: NOA,
      email: `noa@${stack.slug}.test`,
      startDate: day(7),
    });
    const result = resultOf(await upsert(worker));
    expect(result).toMatchObject({ created: true, linked: false });
    noa = result.person;
    expect(noa).toMatchObject({
      status: 'pre_hire',
      email: `noa@${stack.slug}.test`,
      givenName: 'Noa',
      familyName: 'Barak',
      department: 'Engineering',
      title: 'Platform Engineer',
      site: 'Tel Aviv',
      startDate: day(7),
      manager: expect.objectContaining({ email: stack.admin.email }),
      sources: [expect.objectContaining({ source: 'hibob', sourceId: NOA })],
    });
    // The Onboard flow asks for actions at their first sign-in: fine for a pre-hire, but no email before they start.
    const actions = (notify: boolean) =>
      api(`/api/people/${noa.id}/required-actions`, {
        method: 'POST',
        body: JSON.stringify({ actions: ['configure_second_step', 'accept_terms'], notify }),
      });
    expect((await actions(false)).status).toBe(200);
    expect((await actions(true)).status).toBe(409);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await invites(noa.email!)).toBe(0);
  });

  it('a redelivery changes nothing; an update changes only what moved', async () => {
    const again = resultOf(await upsert(await deliver('employee.created', NOA)));
    expect(again).toMatchObject({ created: false, linked: false, changed: [] });
    expect(again.person.id).toBe(noa.id);
    bob.employees.get(NOA)!.title = 'Staff Engineer';
    const moved = resultOf(await upsert(await deliver('employee.updated', NOA, { fieldUpdatesIds: ['work.title'] })));
    expect(moved.changed).toEqual(['title']);
    expect(moved.person).toMatchObject({ id: noa.id, title: 'Staff Engineer', status: 'pre_hire' });
  });

  it('on employee.joined (their start date in Bob) they become active and get the invite', async () => {
    bob.employees.get(NOA)!.startDate = day(0);
    bob.employees.get(NOA)!.lifecycleStatus = 'employed';
    const joined = resultOf(await upsert(await deliver('employee.joined', NOA)));
    expect(joined.person).toMatchObject({ id: noa.id, status: 'active', startDate: day(0) });
    await until(async () => (await invites(noa.email!)) === 1);
  });

  it('a pre-hire whose start date comes is activated by the worker, with the invite', async () => {
    const rafi = resultOf(await upsert(await deliver('employee.created', RAFI))).person;
    expect(rafi.status).toBe('pre_hire');
    // Their start date moves to today (as tomorrow would come): the event worker's next pass activates them.
    const moved = await api(`/api/people/${rafi.id}`, { method: 'PATCH', body: JSON.stringify({ startDate: day(0) }) });
    expect(moved.status).toBe(200);
    await until(async () => Person.parse(await (await api(`/api/people/${rafi.id}`)).json()).status === 'active');
    await until(async () => (await invites(rafi.email!)) === 1);
    const audit = AuditPage.parse(await (await api('/api/audit?limit=100')).json());
    expect(audit.chainIntact).toBe(true);
    const activated = audit.items.find((e) => e.action === 'identity.activated' && e.targetId === rafi.id);
    expect(activated).toMatchObject({ actorLabel: 'Start dates', data: { startDate: day(0), source: 'hibob' } });
    const created = audit.items.find((e) => e.action === 'identity.created' && e.targetId === rafi.id);
    expect(created).toMatchObject({
      actorLabel: 'HR flows (e2e) (service)',
      data: expect.objectContaining({ source: 'hibob', status: 'pre_hire' }),
    });
  });

  it('links someone already in Landbright by email instead of adding them twice', async () => {
    const email = `omer@${stack.slug}.test`;
    const existing = await api('/api/people', {
      method: 'POST',
      body: JSON.stringify({ email, givenName: 'Omer', familyName: 'Katz', sendInvite: false }),
    });
    expect(existing.status).toBe(201);
    const id = Person.parse(await existing.json()).id;
    bob.employees.get('3332883884017713239')!.email = email;
    const linked = resultOf(await upsert(await deliver('employee.updated', '3332883884017713239')));
    expect(linked).toMatchObject({ created: false, linked: true });
    expect(linked.person).toMatchObject({
      id,
      department: 'Finance',
      sources: [expect.objectContaining({ source: 'hibob' })],
    });
  });

  it('does not bring a deactivated person back', async () => {
    expect((await api(`/api/people/${noa.id}/deactivate`, { method: 'POST' })).status).toBe(200);
    const refused = await upsert(await deliver('employee.updated', NOA));
    expect(refused.error?.message).toMatch(/409/);
  });

  it('refuses a delivery Bob did not sign', async () => {
    const forged = await p.call(p.HiBobTrigger, {}, p.credentials(bob), p.bobEvent('employee.created', NOA), 'forged');
    expect(forged.response?.status).toBe(401);
    expect(forged.items).toBeUndefined();
  });
});
