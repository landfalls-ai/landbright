import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runNode,
  runTestCredentials,
  runWebhook,
  type ExecuteRequest,
  type INodeType,
  type JsonObject,
} from '@landflow/sdk';
import { parse, validate } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { plugin } from '../src/main';
import { Shapes } from '../src/nodes/shapes';
import { ShapesChangesTrigger, ShapesTrigger } from '../src/nodes/shapes-trigger';
import { shapesSignature, tokenStorePath, verifyShapesSignature } from '../src/shapes';
import { method } from './helpers';
import { schema, SHAPES_SEED, shapesDelivery, startFakeShapes, type FakeShapes } from './fake-shapes';

let fake: FakeShapes;
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'hris' };
const creds = (overrides: JsonObject = {}): Record<string, JsonObject> => ({
  shapesApi: {
    baseUrl: fake.baseUrl,
    refreshToken: SHAPES_SEED.refreshToken,
    webhookSecret: SHAPES_SEED.webhookSecret,
    ...overrides,
  },
});
const NODE = (node: INodeType) => ({ id: 'n1', name: 'Node', type: `hris.${node.description.name}`, typeVersion: 1 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- outputs read loosely in assertions
type Out = Record<string, any>;

async function run(node: INodeType, parameters: JsonObject, extra: Partial<ExecuteRequest> = {}) {
  const request: ExecuteRequest = {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: 'manual',
    node: NODE(node),
    parameters,
    itemParameters: [parameters],
    inputs: [[{ json: {} }]],
    credentials: creds(),
    ...extra,
  };
  return runNode(node, request, extras);
}
const out = async (parameters: JsonObject) => {
  const response = await run(Shapes, parameters);
  if (response.error) throw new Error(response.error.message);
  return response.outputs[0].map((i) => i.json as Out);
};

function deliver(
  body: Record<string, unknown>,
  signature: string | false = 'sign',
  headers: Record<string, string> = {},
) {
  const raw = JSON.stringify(body);
  return runWebhook(
    ShapesTrigger,
    {
      protocol: 'landflow.plugin/v1',
      workflowId: 'wf_test',
      node: NODE(ShapesTrigger),
      parameters: {},
      credentials: creds(),
      webhookUrl: 'http://localhost:57300/api/webhook/app/wf_test/n1',
      staticData: {},
      request: {
        method: 'POST',
        path: '/api/webhook/app/wf_test/n1',
        headers: {
          'content-type': 'application/json',
          'x-webhook-id': 'run-1:act-1',
          ...(signature === 'sign' && { 'x-webhook-signature': shapesSignature(SHAPES_SEED.webhookSecret, raw) }),
          ...(signature && signature !== 'sign' && { 'x-webhook-signature': signature }),
          ...headers,
        },
        query: {},
        body: Buffer.from(raw).toString('base64'),
      },
    },
    extras,
  );
}

beforeAll(async () => {
  fake = await startFakeShapes();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.reset();
  process.env.SHAPES_TOKEN_STORE = join(mkdtempSync(join(tmpdir(), 'shapes-store-')), 'tokens.json');
});

describe("the plugin's queries", () => {
  it("are valid against Shapes' published schema", async () => {
    const source = readFileSync(new URL('../src/shapes.ts', import.meta.url), 'utf8');
    const queries = [
      ...source.matchAll(/'((?:query|mutation) [A-Z]\w*[^']+)'|`((?:query|mutation) [A-Z]\w*[^`]+)`/g),
    ].map((m) =>
      (m[1] ?? m[2]!)
        .replace(/\$\{EMPLOYEE\}/g, 'id firstName lastName email workStatus')
        .replace(/\$\{VALUES\}/g, 'employeeId fieldValue textValue updatedAt employeeFieldType { context fieldType }'),
    );
    expect(queries.length).toBeGreaterThanOrEqual(6);
    for (const q of queries)
      expect(
        validate(schema, parse(q)).map((e) => e.message),
        q,
      ).toEqual([]);
  });
});

describe('tokens', () => {
  it('spends the pasted refresh token once, keeps the pair it gets back, and renews when Shapes says so', async () => {
    const ok = await runTestCredentials(plugin, { credentialType: 'shapesApi', data: creds().shapesApi });
    expect(ok).toMatchObject({ ok: true, message: `Authenticated as ${SHAPES_SEED.systemUser.email}` });
    expect(fake.refreshes).toEqual([SHAPES_SEED.refreshToken]);
    const path = tokenStorePath();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain(SHAPES_SEED.refreshToken);

    await out({ operation: 'get', employee: '1002' });
    expect(fake.refreshes).toHaveLength(1); // the access token was still good

    fake.expireAccessTokens();
    await out({ operation: 'get', employee: '1002' });
    // Renewed with the refresh token Shapes gave last time, not the pasted one (spent).
    expect(fake.refreshes).toHaveLength(2);
    expect(fake.refreshes[1]).not.toBe(SHAPES_SEED.refreshToken);
  });

  it('says how to get a new token when the refresh token is refused', async () => {
    const refused = await runTestCredentials(plugin, {
      credentialType: 'shapesApi',
      data: creds({ refreshToken: 'spent-or-made-up' }).shapesApi,
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/refused the refresh token/);
    const response = await run(
      Shapes,
      { operation: 'get', employee: '1002' },
      { credentials: creds({ refreshToken: 'nope' }) },
    );
    expect(response.error?.description).toMatch(/My settings → API tokens/);
  });

  it('refreshes once for two calls at the same moment', async () => {
    await Promise.all([out({ operation: 'get', employee: '1001' }), out({ operation: 'get', employee: '1002' })]);
    expect(fake.refreshes).toEqual([SHAPES_SEED.refreshToken]);
  });
});

describe('Shapes (action)', () => {
  it('reads an employee as a worker, the manager by email', async () => {
    const [lior] = await out({ operation: 'get', employee: '1002' });
    expect(lior).toEqual({
      source: 'shapes',
      sourceId: '1002',
      email: 'lior.benami@landbright.test',
      givenName: 'Lior',
      familyName: 'Ben Ami',
      displayName: 'Lior Ben Ami',
      department: 'Engineering',
      title: 'Backend Engineer',
      site: 'Tel Aviv',
      managerEmail: 'maya.cohen@landbright.test',
      startDate: '2026-11-23',
      endDate: null,
      status: lior.startDate > new Date().toISOString().slice(0, 10) ? 'pending_arrival' : 'active',
    });
  });

  it('finds by email, and fails or outputs nothing when missing', async () => {
    expect((await out({ operation: 'get', employee: 'MAYA.COHEN@landbright.test' }))[0].sourceId).toBe('1001');
    expect((await out({ operation: 'search', email: 'maya.cohen@landbright.test' })).map((w) => w.sourceId)).toEqual([
      '1001',
    ]);
    expect(await out({ operation: 'get', employee: 'nobody@landbright.test', notFound: 'skip' })).toEqual([]);
    const response = await run(Shapes, { operation: 'get', employee: '9999' });
    expect(response.error?.message).toMatch(/Shapes has no employee "9999"/);
  });

  it('gets the employees changed since a time, a leaver by their termination date', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    fake.upsert({ id: '1001', terminationDate: '2026-12-31' });
    const changed = await out({ operation: 'changed', since });
    expect(changed.map((w) => [w.sourceId, w.endDate])).toEqual([['1001', '2026-12-31']]);
  });

  it('waits out a rate limit', async () => {
    await out({ operation: 'get', employee: '1001' });
    fake.throttle(1);
    expect((await out({ operation: 'get', employee: '1001' }))[0].sourceId).toBe('1001');
  });
});

describe('Shapes Trigger', () => {
  it('needs the webhook secret and a working token to publish', async () => {
    const without = await method(ShapesTrigger, 'create', {}, creds({ webhookSecret: '' }));
    expect(without.error?.message).toMatch(/no Webhook Secret/);
    const ok = await method(ShapesTrigger, 'create', {}, creds());
    expect(ok.error).toBeUndefined();
  });

  it('turns a signed delivery into the worker, keyed by the delivery', async () => {
    const response = await deliver(shapesDelivery(fake, '1002', ['start_date', 'job']));
    expect(response.response).toBeUndefined();
    const [item] = response.items!.map((i) => i.json as Out);
    expect(item).toMatchObject({
      source: 'shapes',
      sourceId: '1002',
      email: 'lior.benami@landbright.test',
      event: 'shapes.workflow',
      workflow: 'Tell Landbright',
      changedFields: ['job', 'start_date'],
    });
    expect(response.idempotencyKey).toBe('shapes:run-1:act-1:1002');
  });

  it('refuses a bad signature and a stale delivery', async () => {
    const body = shapesDelivery(fake, '1002');
    expect((await deliver(body, false)).response?.status).toBe(401);
    expect((await deliver(body, 'deadbeef')).response?.status).toBe(401);
    expect((await deliver({ ...body, timestamp: Date.now() - 10 * 60_000 })).response?.status).toBe(401);
    expect((await deliver({ hello: 'world', timestamp: Date.now() })).response?.status).toBe(400);
  });

  it('accepts the signature in hex, with a sha256= prefix, or in base64', () => {
    const raw = '{"a":1}';
    const hex = shapesSignature('s', raw);
    expect(verifyShapesSignature('s', raw, hex)).toBe(true);
    expect(verifyShapesSignature('s', raw, `sha256=${hex}`)).toBe(true);
    expect(verifyShapesSignature('s', raw, Buffer.from(hex, 'hex').toString('base64'))).toBe(true);
    expect(verifyShapesSignature('s', raw, shapesSignature('other', raw))).toBe(false);
  });

  it('answers 503 when Shapes can’t be read, rather than start a run without the employee', async () => {
    const response = await deliver(shapesDelivery(fake, '1002'), 'sign');
    expect(response.items).toHaveLength(1);
    const broken = await runWebhook(
      ShapesTrigger,
      {
        protocol: 'landflow.plugin/v1',
        workflowId: 'wf_test',
        node: NODE(ShapesTrigger),
        parameters: {},
        credentials: creds({ baseUrl: 'http://127.0.0.1:9/v1' }),
        webhookUrl: 'http://localhost:57300/api/webhook/app/wf_test/n1',
        staticData: {},
        request: (() => {
          const raw = JSON.stringify(shapesDelivery(fake, '1002'));
          return {
            method: 'POST',
            path: '/api/webhook/app/wf_test/n1',
            headers: {
              'content-type': 'application/json',
              'x-webhook-signature': shapesSignature(SHAPES_SEED.webhookSecret, raw),
            },
            query: {},
            body: Buffer.from(raw).toString('base64'),
          };
        })(),
      },
      extras,
    );
    expect(broken.response?.status).toBe(503);
  });
});

describe('Shapes Changes Trigger', () => {
  const poll = (pollState?: JsonObject) =>
    run(ShapesChangesTrigger, { pollInterval: 900 }, { mode: 'poll', inputs: [], ...(pollState && { pollState }) });

  it('sets a baseline first, then outputs who changed since, with a few minutes of overlap', async () => {
    const first = await poll();
    expect(first.outputs[0] ?? []).toEqual([]);
    const state = first.pollState as { since: string };
    expect(Date.now() - new Date(state.since).getTime()).toBeGreaterThanOrEqual(5 * 60_000 - 1000);

    fake.upsert({ id: '1002', job: 'Staff Engineer' });
    fake.upsert({
      id: '1003',
      firstName: 'Noa',
      lastName: 'Barak',
      email: 'noa.barak@landbright.test',
      department: 'Finance',
      startDate: '2026-12-01',
    });
    const second = await poll(state);
    expect(
      second.outputs[0]!.map((i) => [(i.json as Out).sourceId, (i.json as Out).title ?? (i.json as Out).department]),
    ).toEqual([
      ['1002', 'Staff Engineer'],
      ['1003', 'Finance'],
    ]);
    expect(new Date((second.pollState as { since: string }).since).getTime()).toBeGreaterThanOrEqual(
      new Date(state.since).getTime(),
    );
  });
});
