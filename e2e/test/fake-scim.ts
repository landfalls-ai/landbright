import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Two SCIM servers that behave like the real ones Landbright pushes to, as read from their source (spec 006, plan's
 * design review), in memory:
 *
 * - `landflow`: users and groups stored; 409 on a taken userName, externalId or group name; filters on userName,
 *   externalId and displayName; PATCH with path-less values; members by id, unknown ids dropped; `active: false`
 *   deletes the person's sessions.
 * - `landfall`: POST is create-or-link (never 409) and always activates; a role chosen from the person's `groups`;
 *   only `userName eq` filters; PATCH reads only `active` and `groups`; no Groups at all; bodies sent as
 *   `application/scim+json` arrive empty (its parser takes `application/json` only).
 */
export type Dialect = 'landflow' | 'landfall';

export interface FakeUser {
  id: string;
  userName: string;
  externalId?: string;
  displayName?: string;
  active: boolean;
  groups: string[];
  role?: string;
}

export interface FakeGroup {
  id: string;
  displayName: string;
  externalId?: string;
  members: string[];
}

export class FakeScim {
  readonly users = new Map<string, FakeUser>();
  readonly groups = new Map<string, FakeGroup>();
  /** Signed-in sessions, by user id: what deactivation must end. */
  readonly sessions = new Set<string>();
  readonly calls: Array<{ method: string; path: string; body: unknown }> = [];
  token: string;
  private failures: number[] = [];
  private server?: Server;
  url = '';

  constructor(
    readonly dialect: Dialect,
    token = `tok-${randomUUID()}`,
  ) {
    this.token = token;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done));
    const base = this.dialect === 'landfall' ? '/scim/v2/acme' : '/scim/v2';
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${base}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((done) => (this.server ? this.server.close(() => done()) : done()));
  }

  /** The next calls answer these statuses instead (503: the server is down). */
  failNext(...statuses: number[]): void {
    this.failures.push(...statuses);
  }

  byUserName(email: string): FakeUser | undefined {
    return [...this.users.values()].find((u) => u.userName === email.toLowerCase());
  }

  byGroupName(name: string): FakeGroup | undefined {
    return [...this.groups.values()].find((g) => g.displayName.toLowerCase() === name.toLowerCase());
  }

  /** An account made outside Landbright: at a first sign-in, or by hand. */
  seedUser(email: string, extra: Partial<FakeUser> = {}): FakeUser {
    const user: FakeUser = {
      id: `usr_${randomUUID().slice(0, 8)}`,
      userName: email,
      active: true,
      groups: [],
      ...extra,
    };
    this.users.set(user.id, user);
    return user;
  }

  signIn(user: FakeUser): void {
    this.sessions.add(user.id);
  }

  private send(res: ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, { 'content-type': 'application/scim+json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  private error(res: ServerResponse, status: number, detail: string, scimType?: string) {
    this.send(res, status, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    });
  }

  private userView(u: FakeUser) {
    return this.dialect === 'landfall'
      ? {
          id: u.id,
          userName: u.userName,
          active: u.active,
          emails: [{ value: u.userName, primary: true }],
          groups: u.role ? [{ value: u.role, display: u.role }] : [],
        }
      : {
          id: u.id,
          userName: u.userName,
          externalId: u.externalId,
          displayName: u.displayName,
          active: u.active,
          groups: [...this.groups.values()]
            .filter((g) => g.members.includes(u.id))
            .map((g) => ({ value: g.id, display: g.displayName })),
        };
  }

  private groupView(g: FakeGroup) {
    return {
      id: g.id,
      displayName: g.displayName,
      externalId: g.externalId,
      members: g.members.map((value) => ({ value })),
    };
  }

  private deactivate(u: FakeUser) {
    u.active = false;
    this.sessions.delete(u.id);
  }

  private roleFrom(groups: unknown): string {
    const names = Array.isArray(groups)
      ? groups.map((g) =>
          String(
            (g as { display?: string; value?: string }).display ?? (g as { value?: string }).value ?? '',
          ).toLowerCase(),
        )
      : [];
    return names.find((n) => n.includes('admin')) ? 'admin' : 'responder';
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const url = new URL(req.url ?? '/', 'http://fake');
    let body: Record<string, unknown> = {};
    // Landfall's parser takes application/json only: anything else arrives empty.
    if (raw && (this.dialect === 'landflow' || (req.headers['content-type'] ?? '').startsWith('application/json')))
      body = JSON.parse(raw);
    const base = new URL(this.url).pathname;
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    this.calls.push({ method: req.method ?? '', path: `${path}${url.search}`, body });
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.error(res, 401, 'Missing or wrong token');
    const failure = this.failures.shift();
    if (failure) return this.error(res, failure, 'Failing as asked');
    const [, kind, id] = path.split('/');
    if (kind === 'ServiceProviderConfig')
      return this.send(res, 200, { patch: { supported: true }, filter: { supported: true, maxResults: 200 } });
    if (kind === 'Users') return this.users_(req.method!, id, url, body, res);
    if (kind === 'Groups' && this.dialect === 'landflow') return this.groups_(req.method!, id, url, body, res);
    return this.error(res, 404, 'No such route');
  }

  private filter(url: URL, allowed: string[]): { attribute: string; value: string } | null | 'bad' {
    const f = url.searchParams.get('filter');
    if (!f) return null;
    const m = /^(\w+) eq "((?:[^"\\]|\\.)*)"$/.exec(f);
    if (!m || !allowed.includes(m[1]!)) return 'bad';
    return { attribute: m[1]!, value: m[2]!.replace(/\\(.)/g, '$1') };
  }

  private users_(method: string, id: string | undefined, url: URL, body: Record<string, unknown>, res: ServerResponse) {
    if (method === 'GET' && !id) {
      const f = this.filter(url, this.dialect === 'landfall' ? ['userName'] : ['userName', 'externalId']);
      if (f === 'bad') return this.error(res, 400, 'Unsupported filter', 'invalidFilter');
      const all = [...this.users.values()].filter(
        (u) => !f || String(u[f.attribute as keyof FakeUser] ?? '').toLowerCase() === f.value.toLowerCase(),
      );
      return this.send(res, 200, { totalResults: all.length, Resources: all.map((u) => this.userView(u)) });
    }
    if (method === 'POST') {
      const userName = String(body.userName ?? '').toLowerCase();
      if (!userName) return this.error(res, 400, 'userName or emails is required');
      const existing = this.byUserName(userName);
      if (this.dialect === 'landfall') {
        const user = existing ?? this.seedUser(userName);
        user.active = true;
        user.externalId = String(body.externalId ?? user.externalId ?? '');
        user.role = this.roleFrom(body.groups);
        return this.send(res, 201, this.userView(user));
      }
      if (existing) return this.error(res, 409, `A user with the userName ${userName} already exists`, 'uniqueness');
      if (body.externalId && [...this.users.values()].some((u) => u.externalId === body.externalId))
        return this.error(
          res,
          409,
          `A user with the externalId ${String(body.externalId)} already exists`,
          'uniqueness',
        );
      const user = this.seedUser(userName, {
        externalId: body.externalId as string,
        displayName: body.displayName as string,
        active: body.active !== false,
      });
      return this.send(res, 201, this.userView(user));
    }
    const user = id ? this.users.get(id) : undefined;
    if (!user) return this.error(res, 404, 'No such user');
    if (method === 'GET') return this.send(res, 200, this.userView(user));
    if (method === 'DELETE') {
      if (this.dialect === 'landfall') this.deactivate(user);
      else this.users.delete(user.id);
      return this.send(res, 204);
    }
    if (method !== 'PATCH') return this.error(res, 405, 'No PUT here');
    const ops = (body.Operations ?? []) as Array<{ op: string; path?: string; value?: unknown }>;
    if (this.dialect === 'landfall') {
      // Only active and groups; active:false wins and ends it.
      const flat = ops.flatMap((o) =>
        o.path ? [[o.path, o.value] as const] : Object.entries((o.value ?? {}) as Record<string, unknown>),
      );
      const active = flat.find(([k]) => k === 'active');
      if (active && String(active[1]).toLowerCase() === 'false') {
        this.deactivate(user);
        return this.send(res, 200, this.userView(user));
      }
      if (active) user.active = true;
      const groups = flat.find(([k]) => k === 'groups');
      if (groups) user.role = this.roleFrom(groups[1]);
      return this.send(res, 200, this.userView(user));
    }
    for (const o of ops) {
      const values = o.path ? { [o.path]: o.value } : ((o.value ?? {}) as Record<string, unknown>);
      for (const [key, value] of Object.entries(values)) {
        if (key === 'active') {
          if (String(value).toLowerCase() === 'false') this.deactivate(user);
          else user.active = true;
        } else if (key === 'userName') user.userName = String(value).toLowerCase();
        else if (key === 'displayName') user.displayName = String(value);
        else if (key === 'externalId') {
          if ([...this.users.values()].some((u) => u.id !== user.id && u.externalId === value))
            return this.error(res, 409, `Another user has the externalId ${String(value)}`, 'uniqueness');
          user.externalId = String(value);
        } else if (key === 'name' || key.startsWith('name.') || key === 'emails') continue;
        else return this.error(res, 400, `Unsupported path ${key}`, 'invalidPath');
      }
    }
    return this.send(res, 200, this.userView(user));
  }

  private groups_(
    method: string,
    id: string | undefined,
    url: URL,
    body: Record<string, unknown>,
    res: ServerResponse,
  ) {
    const known = (values: unknown) =>
      (Array.isArray(values) ? values : [])
        .map((m) => String((m as { value?: string }).value ?? ''))
        .filter((v) => this.users.has(v)); // unknown ids are dropped, as Landflow does
    if (method === 'GET' && !id) {
      const f = this.filter(url, ['displayName', 'externalId']);
      if (f === 'bad') return this.error(res, 400, 'Unsupported filter', 'invalidFilter');
      const all = [...this.groups.values()].filter(
        (g) => !f || String(g[f.attribute as keyof FakeGroup] ?? '').toLowerCase() === f.value.toLowerCase(),
      );
      return this.send(res, 200, { totalResults: all.length, Resources: all.map((g) => this.groupView(g)) });
    }
    if (method === 'POST') {
      const displayName = String(body.displayName ?? '');
      if (this.byGroupName(displayName))
        return this.error(res, 409, `A group named “${displayName}” already exists`, 'uniqueness');
      const group: FakeGroup = {
        id: `grp_${randomUUID().slice(0, 8)}`,
        displayName,
        externalId: body.externalId as string,
        members: known(body.members),
      };
      this.groups.set(group.id, group);
      return this.send(res, 201, this.groupView(group));
    }
    const group = id ? this.groups.get(id) : undefined;
    if (!group) return this.error(res, 404, 'No such group');
    if (method === 'GET') return this.send(res, 200, this.groupView(group));
    if (method === 'DELETE') {
      this.groups.delete(group.id);
      return this.send(res, 204);
    }
    if (method !== 'PATCH') return this.error(res, 405, 'Not here');
    for (const o of (body.Operations ?? []) as Array<{ op: string; path?: string; value?: unknown }>) {
      const op = o.op.toLowerCase();
      const removeOne = /^members\[value eq "(.+)"\]$/.exec(o.path ?? '');
      if (op === 'remove' && removeOne) group.members = group.members.filter((m) => m !== removeOne[1]);
      else if (o.path === 'members' && op === 'add')
        group.members = [...new Set([...group.members, ...known(o.value)])];
      else if (o.path === 'members' && op === 'replace') group.members = known(o.value);
      else if (o.path === 'displayName') group.displayName = String(o.value);
      else if (o.path === 'externalId') group.externalId = String(o.value);
      else return this.error(res, 400, `Unsupported operation ${o.op} ${o.path ?? ''}`, 'invalidPath');
    }
    return this.send(res, 200, this.groupView(group));
  }
}
