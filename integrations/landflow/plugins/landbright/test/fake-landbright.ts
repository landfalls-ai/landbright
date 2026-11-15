/* eslint-disable @typescript-eslint/no-explicit-any -- a fake server reads whatever it is sent */
/**
 * A fake Landbright for the plugin's unit tests: `{issuer}/token` (client credentials with the machine API resource)
 * and the `/api/v1` routes the Landbright node calls. The e2e tests run the same node against the real stack.
 */
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CLIENT = { id: 'landflow-fake', secret: 'fake-client-secret-0123456789' };

export interface FakeLandbright {
  url: string;
  issuer: string;
  tokensIssued: number;
  people: Map<string, any>;
  groups: Array<{ id: string; name: string; members: string[] }>;
  requests: Array<{ method: string; path: string; body: any; auth?: string }>;
  subscriptions: Array<{ id: string; url: string; events: string[]; audience: string; description?: string }>;
  /** A delivery's token as Landbright signs it (a SET with the event inside); `key: 'other'` signs with a key not in the JWKS. */
  sign(event: any, options?: { audience?: string; typ?: string; key?: 'other'; expiresIn?: string }): Promise<string>;
  close(): Promise<void>;
}

/** The scopes the fake application has; a token request may ask for any of them. */
const SCOPES = new Set(['directory:read', 'directory:write', 'events:manage']);

export async function startFakeLandbright(): Promise<FakeLandbright> {
  const state: FakeLandbright = {
    url: '',
    issuer: '',
    tokensIssued: 0,
    people: new Map(),
    groups: [{ id: randomUUID(), name: 'Engineers', members: [] }],
    requests: [],
    subscriptions: [],
    sign: async () => '',
    close: async () => {},
  };
  const keys = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'fake-key-1', alg: 'RS256', use: 'sig' };
  const live = new Set<string>();
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const [path, query = ''] = (req.url ?? '/').split('?');
    if (req.method === 'POST' && path === '/oidc/token') {
      const form = new URLSearchParams(raw);
      const expected = `Basic ${Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString('base64')}`;
      if (req.headers.authorization !== expected)
        return send(401, { error: 'invalid_client', error_description: 'client authentication failed' });
      if (
        form.get('grant_type') !== 'client_credentials' ||
        form.get('resource') !== 'urn:landbright:api' ||
        !(form.get('scope') ?? '').split(' ').every((scope) => SCOPES.has(scope))
      )
        return send(400, { error: 'invalid_target' });
      const token = `tok-${randomUUID()}`;
      live.add(token);
      state.tokensIssued++;
      return send(200, { access_token: token, token_type: 'Bearer', expires_in: 600 });
    }
    if (req.method === 'GET' && path === '/oidc/jwks') return send(200, { keys: [jwk] });
    const body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ method: req.method ?? 'GET', path, body, auth: req.headers.authorization });
    if (!live.has(String(req.headers.authorization ?? '').replace(/^Bearer /, '')))
      return send(401, { message: 'Unauthorized', statusCode: 401 });
    if (req.method === 'POST' && path === '/api/v1/people') {
      if (!body?.email || !body?.givenName)
        return send(400, { message: 'Validation failed', errors: [{ path: ['email'], message: 'Required' }] });
      const existing = [...state.people.values()].find((p) => p.sourceId === body.sourceId);
      if (existing?.status === 'deactivated')
        return send(409, {
          message: "They were deactivated; reactivating is a person's decision in the console.",
          statusCode: 409,
        });
      const person = {
        id: existing?.id ?? randomUUID(),
        ...existing,
        ...body,
        status: body.startDate && body.startDate > '2026-11-14' ? 'pre_hire' : 'active',
      };
      state.people.set(person.id, person);
      return send(existing ? 200 : 201, {
        person,
        created: !existing,
        linked: false,
        changed: existing ? ['title'] : [],
      });
    }
    const bySource = /^\/api\/v1\/people\/by-source\/([^/]+)\/([^/]+)$/.exec(path);
    if (bySource) {
      const person = [...state.people.values()].find(
        (p) => p.source === decodeURIComponent(bySource[1]) && p.sourceId === decodeURIComponent(bySource[2]),
      );
      return person ? send(200, person) : send(404, { message: 'No one is linked to that record', statusCode: 404 });
    }
    const birthright = /^\/api\/v1\/people\/([^/]+)\/birthright-groups$/.exec(path);
    if (birthright && req.method === 'PUT') {
      const person = state.people.get(birthright[1]);
      if (!person) return send(404, { message: 'No such person', statusCode: 404 });
      const names: string[] = body.groups;
      const added: string[] = [];
      const removed: string[] = [];
      for (const g of state.groups) {
        const member = g.members.includes(person.id);
        if (names.includes(g.name) && !member) {
          g.members.push(person.id);
          added.push(g.name);
        } else if (!names.includes(g.name) && member) {
          g.members = g.members.filter((m) => m !== person.id);
          removed.push(g.name);
        }
      }
      const missing = names.filter((n) => !state.groups.some((g) => g.name === n));
      return send(200, { person, added, removed, missing });
    }
    if (path === '/api/v1/subscriptions' && req.method === 'GET') return send(200, { items: state.subscriptions });
    if (path === '/api/v1/subscriptions' && req.method === 'POST') {
      const subscription = { id: randomUUID(), ...body };
      state.subscriptions.push(subscription);
      return send(201, subscription);
    }
    const subscription = /^\/api\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (subscription && req.method === 'DELETE') {
      const before = state.subscriptions.length;
      state.subscriptions = state.subscriptions.filter((x) => x.id !== subscription[1]);
      if (state.subscriptions.length === before) return send(404, { message: 'No such subscription', statusCode: 404 });
      res.writeHead(204).end();
      return;
    }
    const one = /^\/api\/v1\/people\/([^/]+)(\/deactivate)?$/.exec(path);
    if (one) {
      const person = state.people.get(one[1]);
      if (!person) return send(404, { message: 'No such person', statusCode: 404 });
      if (one[2]) {
        person.status = 'deactivated';
        return send(200, { id: person.id, status: person.status });
      }
      return send(200, person);
    }
    if (req.method === 'GET' && path === '/api/v1/groups') {
      const name = new URLSearchParams(query).get('name');
      return send(200, {
        items: state.groups.filter((g) => !name || g.name === name).map(({ members: _m, ...g }) => g),
      });
    }
    const members = /^\/api\/v1\/groups\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path);
    if (members) {
      const group = state.groups.find((g) => g.id === members[1]);
      if (!group) return send(404, { message: 'No such group', statusCode: 404 });
      if (req.method === 'POST') group.members = [...new Set([...group.members, body.identityId])];
      if (req.method === 'DELETE') group.members = group.members.filter((m) => m !== members[2]);
      return send(200, { ...group });
    }
    return send(404, { message: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.issuer = `${state.url}/oidc`;
  state.sign = (event, options = {}) => {
    const key: CryptoKey = options.key === 'other' ? other.privateKey : keys.privateKey;
    return new SignJWT({ event, type: event.type, events: { [`urn:landbright:event:${event.type}`]: {} } })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-key-1', typ: options.typ ?? 'secevent+jwt' })
      .setIssuer(state.issuer)
      .setAudience(options.audience ?? 'http://localhost:57300')
      .setJti(event.id)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(key);
  };
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
