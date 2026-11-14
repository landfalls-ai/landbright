/** The HiBob credential, the HiBob node and the HiBob Trigger against the fake Bob. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HiBob } from '../src/nodes/hibob';
import { DEFAULT_EVENTS, HiBobTrigger } from '../src/nodes/hibob-trigger';
import { bobEvent, SEED, startFakeHiBob, type FakeHiBob } from './fake-hibob';
import { call, credentials, jsonOf, method, run, testCredentials, WEBHOOK_URL } from './helpers';

let fake: FakeHiBob;
beforeAll(async () => {
  fake = await startFakeHiBob();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

const NOA = '3332883884017713238';

describe('HiBob API credential', () => {
  it('passes with the service user and fails with a wrong token', async () => {
    expect(await testCredentials(credentials(fake).hibobApi)).toMatchObject({ ok: true });
    const bad = await testCredentials(credentials(fake, { token: 'wrong' }).hibobApi);
    expect(bad).toMatchObject({ ok: false });
    expect(bad.message).toMatch(/401/);
  });
});

describe('HiBob node', () => {
  it('gets an employee by id or email as a worker', async () => {
    const byId = jsonOf(await run(HiBob, { operation: 'get', employee: NOA }, { credentials: credentials(fake) }));
    expect(byId).toEqual([
      expect.objectContaining({
        source: 'hibob',
        sourceId: NOA,
        email: 'noa.barak@landbright.test',
        department: 'Engineering',
        startDate: '2026-11-21',
      }),
    ]);
    const byEmail = jsonOf(
      await run(HiBob, { operation: 'get', employee: 'omer.katz@landbright.test' }, { credentials: credentials(fake) }),
    );
    expect(byEmail[0]).toMatchObject({ givenName: 'Omer', managerEmail: 'dana.shalev@landbright.test' });
    expect(fake.requests.at(-1)?.body).toMatchObject({ humanReadable: 'APPEND' });
  });

  it('fails on an unknown employee, or outputs nothing when asked', async () => {
    const failed = await run(HiBob, { operation: 'get', employee: 'nobody' }, { credentials: credentials(fake) });
    expect(failed.error?.message).toMatch(/no employee "nobody"/);
    expect(
      jsonOf(
        await run(
          HiBob,
          { operation: 'get', employee: 'nobody', notFound: 'skip' },
          { credentials: credentials(fake) },
        ),
      ),
    ).toEqual([]);
  });

  it('searches by email, inactive people only when asked', async () => {
    fake.employees.get(NOA)!.status = 'Inactive';
    expect(
      jsonOf(
        await run(
          HiBob,
          { operation: 'search', email: 'noa.barak@landbright.test' },
          { credentials: credentials(fake) },
        ),
      ),
    ).toEqual([]);
    expect(
      jsonOf(
        await run(
          HiBob,
          { operation: 'search', email: 'noa.barak@landbright.test', includeInactive: true },
          { credentials: credentials(fake) },
        ),
      ),
    ).toHaveLength(1);
  });

  it('retries a 429 after Retry-After', async () => {
    fake.throttle(2);
    expect(
      jsonOf(await run(HiBob, { operation: 'get', employee: NOA }, { credentials: credentials(fake) })),
    ).toHaveLength(1);
    fake.throttle(3);
    const refused = await run(HiBob, { operation: 'get', employee: NOA }, { credentials: credentials(fake) });
    expect(refused.error?.message).toMatch(/429/);
  });

  it('continues on fail with an error item', async () => {
    const out = jsonOf(
      await run(
        HiBob,
        { operation: 'get', employee: NOA },
        { credentials: credentials(fake, { token: 'wrong' }), continueOnFail: true },
      ),
    );
    expect(out[0].error).toMatch(/401/);
  });
});

describe('HiBob Trigger', () => {
  const params = { events: DEFAULT_EVENTS, fetchEmployee: true };

  it('create checks the credential and keeps the URL; checkExists follows it; delete clears it', async () => {
    const created = await method(HiBobTrigger, 'create', params, credentials(fake));
    expect(created.error).toBeUndefined();
    expect(created.staticData).toEqual({ url: WEBHOOK_URL });
    expect((await method(HiBobTrigger, 'checkExists', params, credentials(fake), created.staticData)).exists).toBe(
      true,
    );
    expect(
      (await method(HiBobTrigger, 'checkExists', params, credentials(fake), { url: 'http://elsewhere' })).exists,
    ).toBe(false);
    expect((await method(HiBobTrigger, 'delete', params, credentials(fake), created.staticData)).staticData).toEqual(
      {},
    );
  });

  it('create refuses without a webhook secret or with a bad token', async () => {
    expect(
      (await method(HiBobTrigger, 'create', params, credentials(fake, { webhookSecret: '' }))).error?.message,
    ).toMatch(/no Webhook Secret/);
    expect(
      (await method(HiBobTrigger, 'create', params, credentials(fake, { token: 'wrong' }))).error?.message,
    ).toMatch(/401/);
  });

  it("answers Bob's ping, in either form, without starting a run", async () => {
    for (const ping of ['Ping test', { text: 'Ping test' }]) {
      const response = await call(HiBobTrigger, params, credentials(fake), ping, false);
      expect(response.items).toBeUndefined();
      expect(response.response?.status).toBe(200);
    }
  });

  it('refuses a delivery without a valid signature', async () => {
    const event = bobEvent('employee.created', NOA);
    for (const signature of [false, 'AAAA', 'x'.repeat(88)]) {
      const response = await call(HiBobTrigger, params, credentials(fake), event, signature);
      expect(response.response?.status).toBe(401);
      expect(response.items).toBeUndefined();
    }
    expect((await call(HiBobTrigger, params, credentials(fake, { webhookSecret: '' }), event)).response?.status).toBe(
      401,
    );
  });

  it('outputs the employee as a worker with the event, keyed for redeliveries', async () => {
    const event = bobEvent('employee.created', NOA);
    const response = await call(HiBobTrigger, params, credentials(fake), event);
    expect(response.error).toBeUndefined();
    expect(response.items?.map((i) => i.json)).toEqual([
      expect.objectContaining({
        source: 'hibob',
        sourceId: NOA,
        email: 'noa.barak@landbright.test',
        startDate: '2026-11-21',
        event: 'employee.created',
        companyId: SEED.companyId,
        changedFields: [],
      }),
    ]);
    expect(response.idempotencyKey).toBe(`employee.created:${NOA}:${event.triggeredAt}`);
  });

  it('carries the changed fields of an update', async () => {
    const response = await call(
      HiBobTrigger,
      params,
      credentials(fake),
      bobEvent('employee.updated', NOA, { fieldUpdatesIds: ['work.title'] }),
    );
    expect(response.items?.[0].json).toMatchObject({ event: 'employee.updated', changedFields: ['work.title'] });
  });

  it('ignores events it was not asked for', async () => {
    const response = await call(
      HiBobTrigger,
      { events: ['employee.joined'] },
      credentials(fake),
      bobEvent('employee.created', NOA),
    );
    expect(response.items).toBeUndefined();
    expect(response.response).toMatchObject({ status: 200 });
  });

  it('without Fetch Employee, outputs the event and the id only', async () => {
    const response = await call(
      HiBobTrigger,
      { ...params, fetchEmployee: false },
      credentials(fake),
      bobEvent('employee.left', NOA),
    );
    expect(response.items?.[0].json).toEqual(
      expect.objectContaining({ source: 'hibob', sourceId: NOA, event: 'employee.left' }),
    );
    expect(response.items?.[0].json).not.toHaveProperty('email');
    expect(fake.requests).toHaveLength(0);
  });

  it("asks Bob to retry (503) when the employee can't be read", async () => {
    const response = await call(
      HiBobTrigger,
      params,
      credentials(fake, { token: 'wrong' }),
      bobEvent('employee.created', NOA),
    );
    expect(response.response?.status).toBe(503);
    expect(response.items).toBeUndefined();
  });

  it('still starts a run for an employee Bob no longer has', async () => {
    const response = await call(HiBobTrigger, params, credentials(fake), bobEvent('employee.inactivated', 'gone-1'));
    expect(response.items?.[0].json).toMatchObject({ sourceId: 'gone-1', event: 'employee.inactivated' });
  });

  it('refuses a signed body that is not an event', async () => {
    expect((await call(HiBobTrigger, params, credentials(fake), { hello: 'world' })).response?.status).toBe(400);
    expect(
      (await call(HiBobTrigger, params, credentials(fake), { type: 'employee.created', data: {} })).response?.status,
    ).toBe(400);
  });
});
