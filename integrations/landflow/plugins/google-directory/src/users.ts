/**
 * Users and group members in Google's directory, the way Landbright's flows need them: idempotent (a 409 on create or
 * add, a 404 on remove, count as done), so two runs for one person converge on the same state.
 */
import { randomBytes } from 'node:crypto';
import type { JsonObject } from '@landflow/sdk';
import { customerOf, directory, GoogleError, type ApiContext, type Body, type GoogleCredentials } from './google';

/** The external id type Landbright's id is kept under on a Google user. */
export const EXTERNAL_ID_TYPE = 'landbright';

export interface Person {
  email: string;
  givenName: string;
  familyName: string;
  /** Landbright's id for the person, kept in the user's externalIds. */
  externalId?: string | null;
  department?: string | null;
  title?: string | null;
  managerEmail?: string | null;
  /** Create only: where the account goes. */
  orgUnitPath?: string | null;
  /** Lift a suspension (a person Landbright reactivated). */
  unsuspend?: boolean;
}

const enc = encodeURIComponent;
const lower = (value: string) => value.trim().toLowerCase();
/** Google caps given and family names at 60 characters. */
const name60 = (value: string) => value.trim().slice(0, 60) || '-';

/** A password nobody learns: Google requires one on create; people sign in through Landbright. */
export function randomPassword(): string {
  return randomBytes(24).toString('base64url');
}

/** A user, or undefined when Google has none by that key. */
export async function getUser(api: ApiContext, credentials: GoogleCredentials, key: string): Promise<Body | undefined> {
  try {
    return await directory(api, credentials, 'GET', `/users/${enc(key)}`);
  } catch (error) {
    if (error instanceof GoogleError && error.status === 404) return undefined;
    throw error;
  }
}

/** The user whose externalIds carry Landbright's id, if any. */
export async function findByExternalId(
  api: ApiContext,
  credentials: GoogleCredentials,
  externalId: string,
): Promise<Body | undefined> {
  const query = enc(`externalId='${externalId.replace(/'/g, '')}'`);
  const body = await directory(
    api,
    credentials,
    'GET',
    `/users?customer=${enc(customerOf(credentials))}&query=${query}&maxResults=2`,
  );
  const users = (body?.users ?? []) as Body[];
  // The query matches any external id with that value; only Landbright's own type counts.
  return users.find((u) => externalIdOf(u) === externalId);
}

export const externalIdOf = (user: Body | undefined): string | undefined =>
  (user?.externalIds as Body[] | undefined)?.find((e) => e.type === 'custom' && e.customType === EXTERNAL_ID_TYPE)
    ?.value;

const organizationOf = (user: Body) =>
  ((user.organizations as Body[] | undefined) ?? []).find((o) => o.primary) ?? user.organizations?.[0];
const managerOf = (user: Body) =>
  ((user.relations as Body[] | undefined) ?? []).find((r) => r.type === 'manager')?.value?.toLowerCase() ?? null;

/** The fields of a patch that would make `user` match `person` (empty when it already does). */
export function differences(user: Body, person: Person): { patch: JsonObject; changed: string[] } {
  const patch: JsonObject = {};
  const changed: string[] = [];
  if (lower(user.primaryEmail ?? '') !== lower(person.email)) {
    patch.primaryEmail = lower(person.email);
    changed.push('primaryEmail');
  }
  const given = name60(person.givenName);
  const family = name60(person.familyName);
  if (user.name?.givenName !== given || user.name?.familyName !== family) {
    patch.name = { givenName: given, familyName: family };
    changed.push('name');
  }
  const org = organizationOf(user) ?? {};
  const department = person.department ?? null;
  const title = person.title ?? null;
  if ((org.department ?? null) !== department || (org.title ?? null) !== title) {
    patch.organizations =
      department || title ? [{ primary: true, ...(department && { department }), ...(title && { title }) }] : [];
    changed.push('organizations');
  }
  const manager = person.managerEmail ? lower(person.managerEmail) : null;
  if (managerOf(user) !== manager) {
    const others = ((user.relations as Body[] | undefined) ?? []).filter((r) => r.type !== 'manager');
    patch.relations = [...others, ...(manager ? [{ type: 'manager', value: manager }] : [])] as JsonObject[];
    changed.push('relations');
  }
  if (person.externalId && externalIdOf(user) !== person.externalId) {
    const others = ((user.externalIds as Body[] | undefined) ?? []).filter(
      (e) => !(e.type === 'custom' && e.customType === EXTERNAL_ID_TYPE),
    );
    patch.externalIds = [
      ...others,
      { type: 'custom', customType: EXTERNAL_ID_TYPE, value: person.externalId },
    ] as JsonObject[];
    changed.push('externalIds');
  }
  if (person.unsuspend && user.suspended === true) {
    patch.suspended = false;
    changed.push('suspended');
  }
  return { patch, changed };
}

export interface UpsertResult extends JsonObject {
  user: JsonObject;
  created: boolean;
  linked: boolean;
  changed: string[];
}

function newUser(person: Person): JsonObject {
  const department = person.department ?? null;
  const title = person.title ?? null;
  return {
    primaryEmail: lower(person.email),
    name: { givenName: name60(person.givenName), familyName: name60(person.familyName) },
    password: randomPassword(),
    changePasswordAtNextLogin: false,
    ...(person.orgUnitPath && { orgUnitPath: person.orgUnitPath }),
    ...(person.externalId && {
      externalIds: [{ type: 'custom', customType: EXTERNAL_ID_TYPE, value: person.externalId }],
    }),
    ...((department || title) && {
      organizations: [{ primary: true, ...(department && { department }), ...(title && { title }) }],
    }),
    ...(person.managerEmail && { relations: [{ type: 'manager', value: lower(person.managerEmail) }] }),
  };
}

/** What the node outputs for a user: never the password (Google doesn't return it; this makes sure). */
export function publicUser(user: Body): JsonObject {
  const { password: _password, hashFunction: _hash, ...rest } = user;
  return rest as JsonObject;
}

/**
 * Create the person's account, or bring the one they have in line: found by Landbright's id, else by email (then
 * linked: Landbright's id is added). A create that meets a 409 (another run made them a moment ago) reads and updates.
 */
export async function upsertUser(
  api: ApiContext,
  credentials: GoogleCredentials,
  person: Person,
): Promise<UpsertResult> {
  if (!person.email?.includes('@')) throw new GoogleError(400, undefined, 'An email is required');
  let user = person.externalId ? await findByExternalId(api, credentials, person.externalId) : undefined;
  let linked = false;
  if (!user) {
    user = await getUser(api, credentials, lower(person.email));
    linked = Boolean(user && person.externalId);
  }
  if (!user) {
    try {
      const created = await directory(api, credentials, 'POST', '/users', newUser(person));
      return { user: publicUser(created ?? {}), created: true, linked: false, changed: [] };
    } catch (error) {
      if (!(error instanceof GoogleError && error.status === 409)) throw error;
      user = await getUser(api, credentials, lower(person.email));
      if (!user) throw error;
      linked = Boolean(person.externalId);
    }
  }
  const { patch, changed } = differences(user, person);
  if (!changed.length) return { user: publicUser(user), created: false, linked: false, changed };
  const updated = await directory(api, credentials, 'PATCH', `/users/${enc(user.id ?? user.primaryEmail)}`, patch);
  return { user: publicUser(updated ?? { ...user, ...patch }), created: false, linked, changed };
}

/** Suspend (and by default sign out everywhere). Nobody by that address: nothing to do. */
export async function suspendUser(
  api: ApiContext,
  credentials: GoogleCredentials,
  email: string,
  signOut = true,
): Promise<JsonObject> {
  const user = await getUser(api, credentials, lower(email));
  if (!user) return { email: lower(email), found: false, suspended: false, signedOut: false };
  const already = user.suspended === true;
  if (!already) await directory(api, credentials, 'PATCH', `/users/${enc(user.id)}`, { suspended: true });
  if (signOut) await directory(api, credentials, 'POST', `/users/${enc(user.id)}/signOut`);
  return { email: lower(email), found: true, suspended: true, alreadySuspended: already, signedOut: signOut };
}

export async function unsuspendUser(
  api: ApiContext,
  credentials: GoogleCredentials,
  email: string,
): Promise<JsonObject> {
  const user = await getUser(api, credentials, lower(email));
  if (!user) throw new GoogleError(404, 'notFound', `Google has no user ${lower(email)}`);
  if (user.suspended === true)
    await directory(api, credentials, 'PATCH', `/users/${enc(user.id)}`, { suspended: false });
  return { email: lower(email), suspended: false, wasSuspended: user.suspended === true };
}

export async function signOutUser(api: ApiContext, credentials: GoogleCredentials, email: string): Promise<JsonObject> {
  await directory(api, credentials, 'POST', `/users/${enc(lower(email))}/signOut`);
  return { email: lower(email), signedOut: true };
}

/** The groups a user is directly in (their emails, lower case). */
export async function groupsOf(api: ApiContext, credentials: GoogleCredentials, email: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken = '';
  do {
    const body = await directory(
      api,
      credentials,
      'GET',
      `/groups?userKey=${enc(lower(email))}&maxResults=200${pageToken ? `&pageToken=${enc(pageToken)}` : ''}`,
    );
    for (const g of (body?.groups ?? []) as Body[]) if (g.email) out.push(lower(String(g.email)));
    pageToken = String(body?.nextPageToken ?? '');
  } while (pageToken);
  return out;
}

/** Add a member; already one counts as done. A new user not yet visible to groups (404) is retried a few times. */
export async function addMember(
  api: ApiContext,
  credentials: GoogleCredentials,
  group: string,
  email: string,
  role = 'MEMBER',
): Promise<'added' | 'already'> {
  const sleep = api.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await directory(api, credentials, 'POST', `/groups/${enc(lower(group))}/members`, { email: lower(email), role });
      return 'added';
    } catch (error) {
      if (error instanceof GoogleError && error.status === 409) return 'already';
      // A user created a moment ago may not be known to groups yet; Google documents no delay, so try a few times.
      if (error instanceof GoogleError && error.status === 404 && attempt < 3) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw error;
    }
  }
}

/** Remove a member; not one (or no such membership) counts as done. */
export async function removeMember(
  api: ApiContext,
  credentials: GoogleCredentials,
  group: string,
  email: string,
): Promise<'removed' | 'absent'> {
  try {
    await directory(api, credentials, 'DELETE', `/groups/${enc(lower(group))}/members/${enc(lower(email))}`);
    return 'removed';
  } catch (error) {
    if (error instanceof GoogleError && error.status === 404) return 'absent';
    throw error;
  }
}

/**
 * The user's memberships among `managed` become exactly `wanted`: missing ones added, managed ones not wanted
 * removed. Groups outside `managed` are left alone (someone added them by hand in Google). A wanted group is managed.
 */
export async function setGroups(
  api: ApiContext,
  credentials: GoogleCredentials,
  email: string,
  wanted: string[],
  managed: string[],
): Promise<JsonObject> {
  const want = new Set(wanted.map(lower).filter(Boolean));
  const manage = new Set([...managed.map(lower).filter(Boolean), ...want]);
  const current = new Set(await groupsOf(api, credentials, email));
  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  for (const group of [...want].sort()) {
    if (current.has(group)) kept.push(group);
    else if ((await addMember(api, credentials, group, email)) === 'added') added.push(group);
    else kept.push(group);
  }
  for (const group of [...current].sort()) {
    if (!manage.has(group) || want.has(group)) continue;
    if ((await removeMember(api, credentials, group, email)) === 'removed') removed.push(group);
  }
  return { email: lower(email), added, removed, kept };
}
