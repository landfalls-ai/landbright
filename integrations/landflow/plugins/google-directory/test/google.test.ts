import { runNode, runTestCredentials, type ExecuteRequest, type JsonObject } from '@landflow/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTokens, readKey, type GoogleCredentials } from '../src/google';
import { plugin } from '../src/main';
import { GoogleDirectory } from '../src/nodes/google-directory';
import { DOMAIN, SEED, startFakeGoogle, type FakeGoogle } from './fake-google';

let fake: FakeGoogle;
const creds = (overrides: Partial<GoogleCredentials> = {}): GoogleCredentials => ({
  serviceAccountEmail: SEED.serviceAccountEmail,
  privateKey: fake.keyFile.private_key,
  adminEmail: SEED.adminEmail,
  customer: 'my_customer',
  baseUrl: fake.url,
  tokenUrl: `${fake.url}/token`,
  ...overrides,
});

function run(
  parameters: JsonObject,
  options: {
    items?: JsonObject[];
    perItem?: JsonObject[];
    credentials?: GoogleCredentials;
    continueOnFail?: boolean;
  } = {},
) {
  const items = options.items ?? [{}];
  const request: ExecuteRequest = {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: 'manual',
    node: { id: 'n1', name: 'Google Directory', type: 'gdirectory.googleDirectory', typeVersion: 1 },
    parameters,
    itemParameters: options.perItem ?? items.map(() => parameters),
    inputs: [items.map((json) => ({ json }))],
    credentials: { googleDirectoryApi: options.credentials ?? creds() },
    ...(options.continueOnFail && { continueOnFail: true }),
  };
  return runNode(GoogleDirectory, request, { credentialTypes: plugin.credentialTypes, pluginId: 'gdirectory' });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the node's output, read loosely in assertions
type Out = Record<string, any>;
const out = async (parameters: JsonObject, options?: Parameters<typeof run>[1]) => {
  const response = await run(parameters, options);
  if (response.error) throw new Error(response.error.message);
  return response.outputs[0].map((item) => item.json as Out);
};

const NOA = {
  resource: 'user',
  operation: 'upsert',
  email: `noa.barak@${DOMAIN}`,
  givenName: 'Noa',
  familyName: 'Barak',
  externalId: '7d1d3c55-2b0f-4b7e-9d7a-1f1c8f6f0a01',
  department: 'Engineering',
  title: 'Platform Engineer',
  managerEmail: `maya.cohen@${DOMAIN}`,
};

beforeAll(async () => {
  fake = await startFakeGoogle();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.reset();
  clearTokens();
});

describe('the credential', () => {
  it('reads the key in every pasted form', () => {
    const pem = fake.keyFile.private_key;
    const forms = [pem, pem.replace(/\n/g, '\\n'), pem.replace(/\n/g, ' '), JSON.stringify(fake.keyFile)];
    for (const privateKey of forms) {
      const { email, pem: read } = readKey({
        ...creds(),
        privateKey,
        serviceAccountEmail: privateKey.startsWith('{') ? '' : SEED.serviceAccountEmail,
      });
      expect(email).toBe(SEED.serviceAccountEmail);
      expect(read.replace(/\s/g, '')).toBe(pem.replace(/\s/g, ''));
    }
    expect(() => readKey({ ...creds(), privateKey: 'not a key' })).toThrow(/PKCS #8/);
  });

  it('tests by getting a token and reading the directory', async () => {
    const ok = await runTestCredentials(plugin, { credentialType: 'googleDirectoryApi', data: creds() });
    expect(ok).toMatchObject({ ok: true, message: `Read the directory as ${SEED.adminEmail}` });
  });

  it('says how to grant delegation when Google refuses the administrator', async () => {
    const refused = await runTestCredentials(plugin, {
      credentialType: 'googleDirectoryApi',
      data: creds({ adminEmail: `someone@${DOMAIN}` }),
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/unauthorized/i);
    const response = await run(NOA, { credentials: creds({ adminEmail: `someone@${DOMAIN}` }) });
    expect(response.error?.description).toMatch(/domain-wide delegation/);
  });
});

describe('Create or Update', () => {
  it('creates the account with a password nobody sees and Landbright’s id', async () => {
    const [result] = await out(NOA);
    expect(result).toMatchObject({ created: true, linked: false });
    expect(result.user.password).toBeUndefined();
    const user = [...fake.users.values()].find((u) => u.primaryEmail === NOA.email)!;
    expect(user.password!.length).toBeGreaterThanOrEqual(30);
    expect(user).toMatchObject({
      name: { givenName: 'Noa', familyName: 'Barak' },
      suspended: false,
      externalIds: [{ type: 'custom', customType: 'landbright', value: NOA.externalId }],
      organizations: [{ primary: true, department: 'Engineering', title: 'Platform Engineer' }],
      relations: [{ type: 'manager', value: NOA.managerEmail }],
    });
  });

  it('changes nothing when nothing differs, and only what differs otherwise', async () => {
    await out(NOA);
    const before = fake.requests.length;
    const [same] = await out(NOA);
    expect(same).toMatchObject({ created: false, changed: [] });
    expect(fake.requests.slice(before).map((r) => r.method)).toEqual(['GET']);
    const [moved] = await out({ ...NOA, department: 'Payments', managerEmail: '' });
    expect(moved.changed).toEqual(['organizations', 'relations']);
    const user = [...fake.users.values()].find((u) => u.primaryEmail === NOA.email)!;
    expect(user.organizations).toEqual([{ primary: true, department: 'Payments', title: 'Platform Engineer' }]);
    expect(user.relations).toEqual([]);
  });

  it('follows an email change by Landbright’s id, and links an account made by hand', async () => {
    await out(NOA);
    const [renamed] = await out({ ...NOA, email: `noa.levi@${DOMAIN}`, familyName: 'Levi' });
    expect(renamed.changed).toEqual(['primaryEmail', 'name']);
    expect([...fake.users.values()].filter((u) => u.primaryEmail.startsWith('noa.'))).toHaveLength(1);

    // An account an administrator made in Google before Landbright knew them: linked, not duplicated.
    await out({ ...NOA, email: `omer.katz@${DOMAIN}`, givenName: 'Omer', familyName: 'Katz', externalId: '' });
    const [linked] = await out({
      ...NOA,
      email: `omer.katz@${DOMAIN}`,
      givenName: 'Omer',
      familyName: 'Katz',
      externalId: 'b5c0d8a2-0000-4000-8000-000000000002',
    });
    expect(linked).toMatchObject({ created: false, linked: true, changed: ['externalIds'] });
  });

  it('counts a 409 from a run beside it as theirs, and unsuspends only when asked', async () => {
    await out(NOA);
    fake.users.forEach((u) => {
      if (u.primaryEmail === NOA.email) u.suspended = true;
    });
    // Another run created them between our read and our create: Google's 409 leads to a read and an update.
    const [again] = await out({ ...NOA, externalId: '' });
    expect(again.created).toBe(false);
    expect([...fake.users.values()].find((u) => u.primaryEmail === NOA.email)!.suspended).toBe(true);
    const [back] = await out({ ...NOA, unsuspend: true });
    expect(back.changed).toEqual(['suspended']);
  });

  it('refuses an address outside the domain with Google’s message', async () => {
    const response = await run({ ...NOA, email: 'noa@elsewhere.example' });
    expect(response.error?.message).toMatch(/Google Directory API error 400 \(invalid\)/);
  });
});

describe('Suspend, Unsuspend, Sign Out', () => {
  it('suspends and signs out everywhere; nobody to suspend is nothing to do', async () => {
    await out(NOA);
    const [done] = await out({ resource: 'user', operation: 'suspend', email: NOA.email });
    expect(done).toMatchObject({ found: true, suspended: true, signedOut: true, alreadySuspended: false });
    const user = [...fake.users.values()].find((u) => u.primaryEmail === NOA.email)!;
    expect(user).toMatchObject({ suspended: true, signOuts: 1 });
    const [twice] = await out({ resource: 'user', operation: 'suspend', email: NOA.email, signOut: false });
    expect(twice).toMatchObject({ alreadySuspended: true, signedOut: false });
    const [none] = await out({ resource: 'user', operation: 'suspend', email: `nobody@${DOMAIN}` });
    expect(none).toMatchObject({ found: false });
    const [back] = await out({ resource: 'user', operation: 'unsuspend', email: NOA.email });
    expect(back).toMatchObject({ suspended: false, wasSuspended: true });
  });
});

describe('Set Groups', () => {
  it('adds the wanted, removes the managed ones not wanted, and leaves the rest alone', async () => {
    await out(NOA);
    fake.members.get(`sales@${DOMAIN}`)!.add(NOA.email); // added by hand in Google: not managed
    fake.members.get(`finance@${DOMAIN}`)!.add(NOA.email);
    const managed = ['everyone', 'engineering', 'finance', 'payments-oncall'].map((g) => `${g}@${DOMAIN}`).join(', ');
    const [first] = await out({
      resource: 'user',
      operation: 'setGroups',
      email: NOA.email,
      wanted: `everyone@${DOMAIN}, engineering@${DOMAIN}`,
      managed,
    });
    expect(first).toEqual({
      email: NOA.email,
      added: [`engineering@${DOMAIN}`, `everyone@${DOMAIN}`],
      removed: [`finance@${DOMAIN}`],
      kept: [],
    });
    expect(fake.members.get(`sales@${DOMAIN}`)!.has(NOA.email)).toBe(true);
    const [again] = await out({
      resource: 'user',
      operation: 'setGroups',
      email: NOA.email,
      wanted: [`everyone@${DOMAIN}`, `engineering@${DOMAIN}`],
      managed,
    });
    expect(again).toMatchObject({ added: [], removed: [], kept: [`engineering@${DOMAIN}`, `everyone@${DOMAIN}`] });
  });

  it('waits for a new account to reach groups', async () => {
    await out(NOA);
    fake.hide(NOA.email, 1);
    const [result] = await out({
      resource: 'user',
      operation: 'setGroups',
      email: NOA.email,
      wanted: `everyone@${DOMAIN}`,
      managed: '',
    });
    expect(result.added).toEqual([`everyone@${DOMAIN}`]);
  }, 10_000);

  it('adds and removes single members idempotently', async () => {
    await out(NOA);
    const add = { resource: 'group', operation: 'addMember', group: `finance@${DOMAIN}`, member: NOA.email };
    expect((await out(add))[0].result).toBe('added');
    expect((await out(add))[0].result).toBe('already');
    const remove = { ...add, operation: 'removeMember' };
    expect((await out(remove))[0].result).toBe('removed');
    expect((await out(remove))[0].result).toBe('absent');
  });
});

describe('limits and errors', () => {
  it('waits out a rate limit', async () => {
    await out(NOA);
    fake.throttle(2);
    const [user] = await out({ resource: 'user', operation: 'get', key: NOA.email });
    expect(user.primaryEmail).toBe(NOA.email);
  }, 15_000);

  it('gets by Landbright’s id, and fails or outputs nothing when missing', async () => {
    await out(NOA);
    expect((await out({ resource: 'user', operation: 'get', key: NOA.externalId }))[0].primaryEmail).toBe(NOA.email);
    expect(await out({ resource: 'user', operation: 'get', key: `nobody@${DOMAIN}`, notFound: 'skip' })).toEqual([]);
    const response = await run({ resource: 'user', operation: 'get', key: `nobody@${DOMAIN}` });
    expect(response.error?.message).toMatch(/Google has no user/);
  });

  it('keeps going per item when asked', async () => {
    const response = await run(NOA, {
      items: [{}, {}],
      perItem: [NOA, { ...NOA, email: 'x@elsewhere.example', externalId: '' }],
      continueOnFail: true,
    });
    expect(response.error).toBeUndefined();
    const [ok, failed] = response.outputs[0].map((item) => item.json as Out);
    expect(ok.created).toBe(true);
    expect(failed.error).toMatch(/400/);
  });
});
