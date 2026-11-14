import { describe, expect, it } from 'vitest';
import { eqFilter, ScimClient, ScimError } from '../src/provisioning/scim-client';
import { desiredUser, groupOps, readActive, readMembers, userOps, userResource } from '../src/provisioning/scim-ops';
import { groupChanges, retryInMs } from '../src/provisioning/scim-sync';

const maya = {
  id: '6f1c2a40-1111-4c1e-9c0e-0a0b0c0d0e0f',
  email: 'maya.cohen@example.test',
  displayName: 'Maya Cohen',
  givenName: 'Maya',
  familyName: 'Cohen',
};

describe('what a person should look like', () => {
  it('pushes email as userName and the Landbright id as externalId', () => {
    const body = userResource(maya.id, desiredUser(maya, true, 'groups', ['Data Team']));
    expect(body).toMatchObject({
      userName: 'maya.cohen@example.test',
      externalId: maya.id,
      displayName: 'Maya Cohen',
      name: { formatted: 'Maya Cohen', givenName: 'Maya', familyName: 'Cohen' },
      emails: [{ value: 'maya.cohen@example.test', type: 'work', primary: true }],
      active: true,
    });
    expect(body).not.toHaveProperty('groups');
  });

  it('carries the groups on the person in user-attribute mode, sorted', () => {
    const body = userResource(maya.id, desiredUser(maya, true, 'user_attribute', ['responder', 'Admins']));
    expect(body.groups).toEqual([
      { value: 'Admins', display: 'Admins' },
      { value: 'responder', display: 'responder' },
    ]);
  });
});

describe('the patch from what was pushed', () => {
  const pushed = desiredUser(maya, true, 'user_attribute', ['Admins']);

  it('sends nothing when nothing changed', () => {
    expect(userOps(maya.id, pushed, pushed)).toEqual([]);
  });

  it('deactivates with active alone', () => {
    expect(userOps(maya.id, pushed, { ...pushed, active: false })).toEqual([
      { op: 'replace', path: 'active', value: false },
    ]);
    expect(userOps(maya.id, { ...pushed, active: false }, { ...pushed, active: false })).toEqual([]);
  });

  it('sends a renamed person as one path-less replace', () => {
    const ops = userOps(maya.id, pushed, { ...pushed, displayName: 'Maya Levi', familyName: 'Levi' });
    expect(ops).toEqual([
      {
        op: 'replace',
        value: {
          userName: maya.email,
          displayName: 'Maya Levi',
          externalId: maya.id,
          name: { formatted: 'Maya Levi', givenName: 'Maya', familyName: 'Levi' },
        },
      },
    ]);
  });

  it('replaces the groups with their path when they change', () => {
    expect(userOps(maya.id, pushed, { ...pushed, groups: [] })).toEqual([{ op: 'replace', path: 'groups', value: [] }]);
  });

  it('sets everything on an account it adopts', () => {
    const ops = userOps(maya.id, null, pushed);
    expect(ops.map((o) => o.path ?? 'attributes')).toEqual(['active', 'attributes', 'groups']);
  });
});

describe('group members', () => {
  it('adds in one operation and removes each by filter', () => {
    expect(
      groupOps({ displayName: 'Data Team', members: ['a', 'b'] }, { displayName: 'Data', members: ['b', 'c', 'd'] }),
    ).toEqual([
      { op: 'replace', path: 'displayName', value: 'Data' },
      { op: 'add', path: 'members', value: [{ value: 'c' }, { value: 'd' }] },
      { op: 'remove', path: 'members[value eq "a"]' },
    ]);
  });

  it('reads members and active the way servers answer them', () => {
    expect(readMembers({ id: 'g', members: [{ value: 'z' }, { value: 'a' }, {}] })).toEqual(['a', 'z']);
    expect(readMembers({ id: 'g' })).toBeNull();
    expect(readActive({ id: 'u', active: 'False' })).toBe(false);
    expect(readActive({ id: 'u', active: true })).toBe(true);
    expect(readActive({ id: 'u' })).toBeNull();
  });
});

describe('the client', () => {
  const answer = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

  it('sends the token and JSON, and reads the id', async () => {
    let seen: Request | undefined;
    const client = new ScimClient('http://scim.test/v2', 'secret-token', async (input, init) => {
      seen = new Request(input as string, init);
      return answer(201, { id: 'usr_1' });
    });
    expect((await client.create('Users', { userName: 'x@y.test' })).id).toBe('usr_1');
    expect(seen?.url).toBe('http://scim.test/v2/Users');
    expect(seen?.headers.get('authorization')).toBe('Bearer secret-token');
    expect(seen?.headers.get('content-type')).toBe('application/json');
  });

  it('turns a SCIM error into a ScimError with its detail and Retry-After', async () => {
    const client = new ScimClient('http://scim.test', 't', async () =>
      answer(429, { status: '429', detail: 'Slow down' }, { 'retry-after': '30' }),
    );
    const error = await client.create('Users', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScimError);
    expect((error as ScimError).message).toContain('429 Slow down');
    expect((error as ScimError).retryAfterMs).toBe(30_000);
    expect((error as ScimError).transient).toBe(true);
  });

  it('answers null for gone resources and for filters a server can’t do', async () => {
    const gone = new ScimClient('http://scim.test', 't', async () => answer(404, { detail: 'no' }));
    expect(await gone.get('Users', 'u')).toBeNull();
    expect(await gone.patch('Users', 'u', [{ op: 'replace', path: 'active', value: false }])).toBe(false);
    await gone.remove('Groups', 'g');
    const cannot = new ScimClient('http://scim.test', 't', async () => answer(400, { scimType: 'invalidFilter' }));
    expect(await cannot.findOne('Users', 'externalId', 'x')).toBeNull();
  });

  it('escapes filter values', () => {
    expect(eqFilter('displayName', 'A "quoted" \\ name')).toBe('displayName eq "A \\"quoted\\" \\\\ name"');
  });

  it('backs off from 5 seconds to an hour, longer when asked', () => {
    expect(retryInMs(1)).toBe(5_000);
    expect(retryInMs(3)).toBe(20_000);
    expect(retryInMs(30)).toBe(3600_000);
    expect(retryInMs(1, 60_000)).toBe(60_000);
  });
});

describe('group changes in user_attribute mode', () => {
  it('says which groups a push added and removed, and nothing in groups mode', () => {
    expect(groupChanges(['A', 'B'], ['B', 'C'])).toEqual({ groupsAdded: ['C'], groupsRemoved: ['A'] });
    expect(groupChanges(undefined, ['A'])).toEqual({ groupsAdded: ['A'] });
    expect(groupChanges(['A'], ['A'])).toEqual({});
    expect(groupChanges(['A'], undefined)).toEqual({});
  });
});
