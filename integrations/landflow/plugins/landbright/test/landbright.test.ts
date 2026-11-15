/** The Landbright credential and node against a fake Landbright. */
import { runTestCredentials, type ExecuteResponse, type JsonObject } from '@landflow/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTokens } from '../src/client';
import { plugin } from '../src/main';
import { namesOf, upsertBody } from '../src/nodes/landbright';
import { runLandbright } from './helpers';
import { CLIENT, startFakeLandbright, type FakeLandbright } from './fake-landbright';

let fake: FakeLandbright;
beforeAll(async () => {
  fake = await startFakeLandbright();
});
afterAll(() => fake.close());
beforeEach(() => clearTokens());

const creds = (overrides: JsonObject = {}) => ({
  controlUrl: fake.url,
  issuer: fake.issuer,
  clientId: CLIENT.id,
  clientSecret: CLIENT.secret,
  ...overrides,
});

function run(
  parameters: JsonObject,
  items: JsonObject[] = [{}],
  options: { credentials?: JsonObject; continueOnFail?: boolean } = {},
): Promise<ExecuteResponse> {
  return runLandbright(parameters, items, options.credentials ?? creds(), options);
}
const jsonOf = (r: ExecuteResponse) => r.outputs[0].map((i) => i.json);

const WORKER = {
  source: 'hibob',
  sourceId: '3332883884017713238',
  email: 'noa.barak@landbright.test',
  givenName: 'Noa',
  familyName: 'Barak',
  displayName: 'Noa Barak',
  department: 'Engineering',
  title: 'Platform Engineer',
  site: null,
  managerEmail: 'maya.cohen@landbright.test',
  startDate: '2026-11-21',
  endDate: null,
  status: 'hired',
  event: 'employee.created',
  changedFields: [],
};

describe('Landbright API credential', () => {
  it('passes when a token comes back, and says why when not', async () => {
    expect(await runTestCredentials(plugin, { credentialType: 'landbrightApi', data: creds() })).toMatchObject({
      ok: true,
    });
    const bad = await runTestCredentials(plugin, {
      credentialType: 'landbrightApi',
      data: creds({ clientSecret: 'wrong' }),
    });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.message).toMatch(/client authentication failed/);
  });
});

describe('Person', () => {
  it("maps a worker to the upsert body: only the API's fields, nulls kept to clear", () => {
    expect(upsertBody(WORKER, true)).toEqual({
      sendInvite: true,
      source: 'hibob',
      sourceId: WORKER.sourceId,
      email: WORKER.email,
      givenName: 'Noa',
      familyName: 'Barak',
      department: 'Engineering',
      title: 'Platform Engineer',
      site: null,
      managerEmail: WORKER.managerEmail,
      startDate: '2026-11-21',
      endDate: null,
    });
    expect(() => upsertBody({ ...WORKER, email: null }, true)).toThrow(/no email/);
    expect(upsertBody({ source: 'hibob', sourceId: '1', email: 'a@b.test', givenName: 'A' }, false)).toEqual({
      sendInvite: false,
      source: 'hibob',
      sourceId: '1',
      email: 'a@b.test',
      givenName: 'A',
    });
  });

  it('creates from the input worker, then updates; one token for both', async () => {
    const tokens = fake.tokensIssued;
    const [created] = jsonOf(await run({ resource: 'person', operation: 'upsert' }, [WORKER]));
    expect(created).toMatchObject({ created: true, person: { status: 'pre_hire', email: WORKER.email } });
    const [updated] = jsonOf(
      await run({ resource: 'person', operation: 'upsert' }, [{ ...WORKER, title: 'Staff Engineer' }]),
    );
    expect(updated).toMatchObject({
      created: false,
      person: { id: (created.person as JsonObject).id, title: 'Staff Engineer' },
    });
    expect(fake.tokensIssued - tokens).toBe(1);
  });

  it('creates from fields', async () => {
    const [out] = jsonOf(
      await run({
        resource: 'person',
        operation: 'upsert',
        useInput: false,
        source: 'hibob',
        sourceId: 'f-1',
        email: 'f1@landbright.test',
        givenName: 'Fay',
        startDate: '2026-01-01',
        sendInvite: false,
      }),
    );
    expect(out).toMatchObject({ created: true, person: { status: 'active' } });
    expect(fake.requests.at(-1)?.body).toMatchObject({ sendInvite: false, sourceId: 'f-1' });
  });

  it("gets and deactivates by id; refuses a deactivated person; carries Landbright's message", async () => {
    const [created] = jsonOf(
      await run({ resource: 'person', operation: 'upsert' }, [
        { ...WORKER, sourceId: 'd-1', email: 'd1@landbright.test' },
      ]),
    );
    const id = (created.person as JsonObject).id as string;
    expect(jsonOf(await run({ resource: 'person', operation: 'get', personId: id }))[0]).toMatchObject({ id });
    expect(
      jsonOf(await run({ resource: 'person', operation: 'deactivate', personId: id, reason: 'Left (HiBob)' }))[0],
    ).toEqual({ id, status: 'deactivated' });
    expect(fake.requests.at(-1)?.body).toEqual({ reason: 'Left (HiBob)' });
    const again = await run({ resource: 'person', operation: 'upsert' }, [
      { ...WORKER, sourceId: 'd-1', email: 'd1@landbright.test' },
    ]);
    expect(again.error?.message).toMatch(/409: They were deactivated/);
    expect((await run({ resource: 'person', operation: 'get', personId: 'not-an-id' })).error?.message).toMatch(
      /not a Landbright id/,
    );
  });

  it("finds the person by the input worker's HR record: get, deactivate; not found fails or outputs nothing", async () => {
    const worker = { ...WORKER, sourceId: 'hr-1', email: 'hr1@landbright.test' };
    const [created] = jsonOf(await run({ resource: 'person', operation: 'upsert' }, [worker]));
    const id = (created.person as JsonObject).id as string;
    const byRecord = { resource: 'person', findBy: 'source' };
    expect(jsonOf(await run({ ...byRecord, operation: 'get' }, [worker]))[0]).toMatchObject({ id });
    // A leaver event's item may carry only the record (Bob couldn't be read): that is enough.
    expect(
      jsonOf(
        await run({ ...byRecord, operation: 'deactivate', reason: 'HiBob: employee.left' }, [
          { source: 'hibob', sourceId: 'hr-1', event: 'employee.left' },
        ]),
      )[0],
    ).toEqual({ id, status: 'deactivated' });
    expect(fake.requests.at(-1)).toMatchObject({ path: `/api/v1/people/${id}/deactivate` });
    const unknown = [{ source: 'hibob', sourceId: 'never-seen' }];
    expect((await run({ ...byRecord, operation: 'deactivate' }, unknown)).error?.message).toMatch(
      /No one in Landbright is linked to hibob record never-seen/,
    );
    const skipped = await run({ ...byRecord, operation: 'deactivate', notFound: 'skip' }, unknown);
    expect(skipped.error).toBeUndefined();
    expect(jsonOf(skipped)).toEqual([]);
    expect((await run({ ...byRecord, operation: 'get' }, [{ email: 'x@y.test' }])).error?.message).toMatch(
      /no source and sourceId/,
    );
  });

  it('sets birthright groups from a list or text; names Landbright lacks come back as missing', async () => {
    const [created] = jsonOf(
      await run({ resource: 'person', operation: 'upsert' }, [
        { ...WORKER, sourceId: 'b-1', email: 'b1@landbright.test' },
      ]),
    );
    const id = (created.person as JsonObject).id as string;
    const set = (groups: unknown) =>
      run({ resource: 'person', operation: 'setBirthright', personId: id, groups } as JsonObject);
    expect(jsonOf(await set('Engineers, Nope\nEngineers'))[0]).toMatchObject({
      added: ['Engineers'],
      removed: [],
      missing: ['Nope'],
    });
    expect(fake.requests.at(-1)).toMatchObject({ method: 'PUT', body: { groups: ['Engineers', 'Nope'] } });
    expect(jsonOf(await set([]))[0]).toMatchObject({ added: [], removed: ['Engineers'] });
    expect(namesOf(' A ,B\n\nA')).toEqual(['A', 'B']);
  });

  it('continues on fail', async () => {
    const out = jsonOf(
      await run(
        { resource: 'person', operation: 'upsert' },
        [
          { ...WORKER, givenName: '' },
          { ...WORKER, sourceId: 'ok-1', email: 'ok1@landbright.test' },
        ],
        { continueOnFail: true },
      ),
    );
    expect(out[0].error).toMatch(/no givenName/);
    expect(out[1]).toMatchObject({ created: true });
  });
});

describe('Group', () => {
  it('finds a group by name and adds and removes a member', async () => {
    const [created] = jsonOf(
      await run({ resource: 'person', operation: 'upsert' }, [
        { ...WORKER, sourceId: 'g-1', email: 'g1@landbright.test' },
      ]),
    );
    const id = (created.person as JsonObject).id as string;
    expect(jsonOf(await run({ resource: 'group', operation: 'getByName', group: 'Engineers' }))[0]).toMatchObject({
      name: 'Engineers',
    });
    expect(
      jsonOf(
        await run({
          resource: 'group',
          operation: 'addMember',
          group: 'Engineers',
          personId: id,
          expiresAt: '2026-12-01T00:00:00Z',
        }),
      )[0],
    ).toMatchObject({ members: [id] });
    expect(fake.requests.at(-1)?.body).toEqual({ identityId: id, expiresAt: '2026-12-01T00:00:00.000Z' });
    expect(
      jsonOf(await run({ resource: 'group', operation: 'removeMember', group: 'Engineers', personId: id }))[0],
    ).toMatchObject({ members: [] });
    expect((await run({ resource: 'group', operation: 'getByName', group: 'Nope' })).error?.message).toMatch(
      /no group "Nope"/,
    );
  });
});
