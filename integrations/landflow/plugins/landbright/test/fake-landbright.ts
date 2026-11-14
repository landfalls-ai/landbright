/* eslint-disable @typescript-eslint/no-explicit-any -- a fake server reads whatever it is sent */
/**
 * A fake Landbright for the plugin's unit tests: `{issuer}/token` (client credentials with the machine API resource)
 * and the `/api/v1` routes the Landbright node calls. The e2e tests run the same node against the real stack.
 */
import { randomUUID } from 'node:crypto';
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
  close(): Promise<void>;
}

export async function startFakeLandbright(): Promise<FakeLandbright> {
  const state: FakeLandbright = {
    url: '',
    issuer: '',
    tokensIssued: 0,
    people: new Map(),
    groups: [{ id: randomUUID(), name: 'Engineers', members: [] }],
    requests: [],
    close: async () => {},
  };
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
        form.get('scope') !== 'directory:read directory:write'
      )
        return send(400, { error: 'invalid_target' });
      const token = `tok-${randomUUID()}`;
      live.add(token);
      state.tokensIssued++;
      return send(200, { access_token: token, token_type: 'Bearer', expires_in: 600 });
    }
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
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
