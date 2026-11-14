import type { GroupsMode } from '@landbright/contracts';
import { GROUP_SCHEMA, type PatchOp, type ScimResource, USER_SCHEMA } from './scim-client';

/**
 * What a person or a group should look like in an application, and the SCIM operations that get it there from what
 * was pushed last. Pure, so the rules are tested without a server.
 */

export interface PersonFacts {
  id: string;
  email: string;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
}

/** What Landbright pushed for a person (kept on the link), and what it wants there now. */
export interface UserState {
  userName: string;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  active: boolean;
  /** user_attribute mode: the names of their assigned groups, sorted. */
  groups?: string[];
}

export interface GroupState {
  displayName: string;
  /** The application's ids of the members, sorted. */
  members: string[];
}

export function desiredUser(person: PersonFacts, active: boolean, mode: GroupsMode, groupNames: string[]): UserState {
  return {
    userName: person.email,
    displayName: person.displayName,
    givenName: person.givenName,
    familyName: person.familyName,
    active,
    ...(mode === 'user_attribute' ? { groups: [...groupNames].sort() } : {}),
  };
}

const nameOf = (s: UserState) => ({
  formatted: s.displayName,
  ...(s.givenName ? { givenName: s.givenName } : {}),
  ...(s.familyName ? { familyName: s.familyName } : {}),
});

const groupsValue = (names: string[]) => names.map((n) => ({ value: n, display: n }));

/** The body of `POST /Users`. `externalId` is the person's id in Landbright: the `sub` of their ID token. */
export function userResource(personId: string, s: UserState): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    userName: s.userName,
    externalId: personId,
    displayName: s.displayName,
    name: nameOf(s),
    emails: [{ value: s.userName, type: 'work', primary: true }],
    active: s.active,
    ...(s.groups ? { groups: groupsValue(s.groups) } : {}),
  };
}

const sameList = (a: string[] | undefined, b: string[] | undefined) =>
  (a ?? []).length === (b ?? []).length && (a ?? []).every((x, i) => x === b?.[i]);

/**
 * From `prev` (null: an account found, not made by Landbright, so everything is set) to `next`. Deactivating sends
 * `active` alone (Landfall reads nothing else once it sees `active: false`); the attributes go as one path-less
 * `replace`, which every server reads; `groups` with its path.
 */
export function userOps(personId: string, prev: UserState | null, next: UserState): PatchOp[] {
  if (!next.active) return prev?.active === false ? [] : [{ op: 'replace', path: 'active', value: false }];
  const ops: PatchOp[] = [];
  if (!prev || prev.active !== true) ops.push({ op: 'replace', path: 'active', value: true });
  if (
    !prev ||
    prev.userName !== next.userName ||
    prev.displayName !== next.displayName ||
    prev.givenName !== next.givenName ||
    prev.familyName !== next.familyName
  )
    ops.push({
      op: 'replace',
      value: { userName: next.userName, displayName: next.displayName, externalId: personId, name: nameOf(next) },
    });
  if (next.groups && (!prev || !sameList(prev.groups, next.groups)))
    ops.push({ op: 'replace', path: 'groups', value: groupsValue(next.groups) });
  return ops;
}

/** The body of `POST /Groups`. */
export function groupResource(groupId: string, s: GroupState): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    displayName: s.displayName,
    externalId: groupId,
    members: s.members.map((value) => ({ value })),
  };
}

/** Members added in one `add`, each removal by its own filtered path (what Landflow, Okta and Entra all accept). */
export function groupOps(current: GroupState, next: GroupState): PatchOp[] {
  const ops: PatchOp[] = [];
  if (current.displayName !== next.displayName)
    ops.push({ op: 'replace', path: 'displayName', value: next.displayName });
  const have = new Set(current.members);
  const want = new Set(next.members);
  const add = next.members.filter((m) => !have.has(m));
  if (add.length) ops.push({ op: 'add', path: 'members', value: add.map((value) => ({ value })) });
  for (const m of current.members.filter((m) => !want.has(m)))
    ops.push({ op: 'remove', path: `members[value eq "${m.replace(/"/g, '\\"')}"]` });
  return ops;
}

/** `active` as a server answers it (some send "True"/"False"); null when it doesn't say. */
export function readActive(resource: ScimResource): boolean | null {
  const v = resource.active;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return null;
}

/** A group's member ids as the server answers them; null when it doesn't list them. */
export function readMembers(resource: ScimResource): string[] | null {
  if (!Array.isArray(resource.members)) return null;
  return resource.members
    .map((m) => (m && typeof m === 'object' ? (m as { value?: unknown }).value : undefined))
    .filter((v): v is string => typeof v === 'string')
    .sort();
}
