/** The Landbright Trigger against a fake Landbright: its subscription follows publishing, and only Landbright's tokens start a run. */
import { runWebhook, runWebhookMethod, type JsonObject } from '@landflow/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTokens } from '../src/client';
import { plugin } from '../src/main';
import { LandbrightTrigger, matches, patternsOf } from '../src/nodes/landbright-trigger';
import { CLIENT, startFakeLandbright, type FakeLandbright } from './fake-landbright';

const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'landbright' };
const NODE = { id: 'n1', name: 'Landbright Trigger', type: 'landbright.landbrightTrigger', typeVersion: 1 };
const URL_ = 'http://localhost:57300/api/webhook/app/wf_test/n1';

let fake: FakeLandbright;
beforeAll(async () => {
  fake = await startFakeLandbright();
});
afterAll(() => fake.close());
beforeEach(() => clearTokens());

const credentials = () => ({
  landbrightApi: {
    controlUrl: fake.url,
    issuer: fake.issuer,
    clientId: CLIENT.id,
    clientSecret: CLIENT.secret,
    scopes: 'events:manage',
  },
});

const method = (name: 'checkExists' | 'create' | 'delete', parameters: JsonObject, staticData: JsonObject = {}) =>
  runWebhookMethod(
    LandbrightTrigger,
    {
      protocol: 'landflow.plugin/v1',
      method: name,
      workflowId: 'wf_test',
      node: NODE,
      parameters,
      credentials: credentials(),
      webhookUrl: URL_,
      staticData,
    },
    extras,
  );

const deliver = (token: string | undefined, staticData: JsonObject, parameters: JsonObject = {}) =>
  runWebhook(
    LandbrightTrigger,
    {
      protocol: 'landflow.plugin/v1',
      workflowId: 'wf_test',
      node: NODE,
      parameters,
      credentials: credentials(),
      webhookUrl: URL_,
      staticData,
      request: {
        method: 'POST',
        path: '/api/webhook/app/wf_test/n1',
        headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
        query: {},
        body: Buffer.from(JSON.stringify({ forged: true })).toString('base64'),
      },
    },
    extras,
  );

const EVENT = {
  id: 'tenant-1.42',
  type: 'identity.deactivated',
  at: '2026-11-15T10:00:00.000Z',
  actor: { id: null, label: 'End dates' },
  target: { type: 'identity', id: '7c1f0000-0000-4000-8000-000000000001' },
  data: { agentsSuspended: ['a-1'], reason: 'Their last day (2026-11-14) ended' },
};

describe('Landbright Trigger', () => {
  it('reads event patterns and matches them as Landbright does', () => {
    expect(patternsOf('identity.deactivated, grant.*\n identity.deactivated')).toEqual([
      'identity.deactivated',
      'grant.*',
    ]);
    expect(matches(['grant.*'], 'grant.revoked')).toBe(true);
    expect(matches(['identity.created'], 'identity.updated')).toBe(false);
    expect(matches(['*'], 'anything')).toBe(true);
  });

  it('subscribes on publish, checks it still exists, replaces it when the events change, removes it on unpublish', async () => {
    const created = await method('create', { events: 'identity.deactivated' });
    expect(created.error).toBeUndefined();
    const data = created.staticData as JsonObject;
    expect(data).toMatchObject({ url: URL_, events: ['identity.deactivated'], audience: 'http://localhost:57300' });
    expect(fake.subscriptions).toEqual([
      expect.objectContaining({
        id: data.subscriptionId,
        url: URL_,
        events: ['identity.deactivated'],
        audience: 'http://localhost:57300',
        description: 'Landflow workflow wf_test, node Landbright Trigger',
      }),
    ]);
    expect((await method('checkExists', { events: 'identity.deactivated' }, data)).exists).toBe(true);
    expect((await method('checkExists', { events: 'identity.*' }, data)).exists).toBe(false);

    const replaced = await method('create', { events: 'identity.*' }, data);
    expect(fake.subscriptions.map((s) => s.events)).toEqual([['identity.*']]);
    const removed = await method('delete', {}, replaced.staticData as JsonObject);
    expect(removed.error).toBeUndefined();
    expect(fake.subscriptions).toEqual([]);
    // Already gone (removed in Landbright's console): still fine.
    expect((await method('delete', {}, replaced.staticData as JsonObject)).error).toBeUndefined();
    expect((await method('checkExists', { events: 'identity.*' }, replaced.staticData as JsonObject)).exists).toBe(
      false,
    );
  });

  it("starts a run with the token's event, keyed by its id; refuses anything Landbright didn't sign", async () => {
    const data = { subscriptionId: 's1', url: URL_, events: ['identity.*'], audience: 'http://localhost:57300' };
    const ok = await deliver(await fake.sign(EVENT), data);
    expect(ok.error).toBeUndefined();
    expect(ok.response?.status).toBe(200);
    // The event in the token, not the body (which says `forged`).
    expect(ok.items?.map((i) => i.json)).toEqual([EVENT]);
    expect(ok.idempotencyKey).toBe(EVENT.id);

    for (const token of [
      undefined,
      'not-a-jwt',
      await fake.sign(EVENT, { key: 'other' }),
      await fake.sign(EVENT, { audience: 'https://elsewhere.test' }),
      await fake.sign(EVENT, { typ: 'JWT' }),
      await fake.sign(EVENT, { expiresIn: '-1m' }),
    ]) {
      const refused = await deliver(token, data);
      expect(refused.response?.status, String(token).slice(0, 20)).toBe(401);
      expect(refused.items).toBeUndefined();
    }
  });

  it('answers and ignores an event its patterns do not name', async () => {
    const data = { subscriptionId: 's1', url: URL_, events: ['grant.*'], audience: 'http://localhost:57300' };
    const ignored = await deliver(await fake.sign(EVENT), data);
    expect(ignored.response?.status).toBe(200);
    expect(JSON.stringify(ignored.response)).toContain('identity.deactivated');
    expect(ignored.items).toBeUndefined();
  });
});
