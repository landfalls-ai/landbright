/* eslint-disable @typescript-eslint/no-explicit-any -- a fake server reads whatever it is sent */
/**
 * A fake Google: the token URL (the JWT bearer grant, checked against the seed service account's public key) and the
 * Directory API routes the gdirectory plugin calls, answering in Google's shapes and error format. Fictitious domain,
 * people and groups; the key pair is made at start. There is no Google tenant here.
 *
 *   pnpm --filter @landbright/plugin-google-directory fake-google   # FAKE_GOOGLE_PORT (default 57995), 127.0.0.1
 *
 * The service account's JSON key file (made at start) is written to FAKE_GOOGLE_KEY_OUT, else
 * `$TMPDIR/landbright-fake-google-key.json` (mode 600), where the installer reads it for the credential.
 * For tests and live checks: GET /_fake/state; POST /_fake/reset; POST /_fake/throttle {n} (the next n API calls
 * answer 429); POST /_fake/hide {email, n} (the next n member adds for that user answer 404, as a new account that
 * groups don't know yet).
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { importSPKI, jwtVerify } from 'jose';
import { SCOPES } from '../src/google';

export const DOMAIN = 'landbright.test';
export const SEED = {
  serviceAccountEmail: 'landbright-sync@fake-project.iam.gserviceaccount.com',
  adminEmail: `it-admin@${DOMAIN}`,
  /** Administrators the service account may act as. */
  admins: [`it-admin@${DOMAIN}`],
};

/** Fictitious groups of the fictitious domain. */
export const GROUPS = ['everyone', 'engineering', 'finance', 'payments-oncall', 'sales'].map((name) => ({
  id: `grp-${name}`,
  email: `${name}@${DOMAIN}`,
  name: name.replace(/(^|-)(\w)/g, (_m, dash, c) => `${dash ? ' ' : ''}${c.toUpperCase()}`),
}));

export interface FakeUser {
  id: string;
  primaryEmail: string;
  name: { givenName: string; familyName: string; fullName?: string };
  suspended: boolean;
  isAdmin: boolean;
  orgUnitPath: string;
  externalIds?: Array<{ type: string; customType?: string; value: string }>;
  organizations?: Array<Record<string, unknown>>;
  relations?: Array<{ type: string; value: string }>;
  creationTime: string;
  /** Kept to check one was sent; never returned. */
  password?: string;
  signOuts: number;
}

export interface FakeGoogle {
  url: string;
  keyFile: { client_email: string; private_key: string; type: string };
  users: Map<string, FakeUser>;
  /** group email → member emails */
  members: Map<string, Set<string>>;
  requests: Array<{ method: string; path: string; body: unknown }>;
  throttle(n: number): void;
  hide(email: string, n: number): void;
  reset(): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Google's error body. */
const gError = (code: number, reason: string, message: string) => ({
  error: { code, message, errors: [{ domain: 'global', reason, message }] },
});

const view = (u: FakeUser) => {
  const { password: _p, signOuts: _s, ...rest } = u;
  return {
    kind: 'admin#directory#user',
    ...rest,
    name: { ...u.name, fullName: `${u.name.givenName} ${u.name.familyName}` },
    ...(u.suspended && { suspensionReason: 'ADMIN' }),
  };
};

export async function startFakeGoogle(port = 0, host = '127.0.0.1'): Promise<FakeGoogle> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const verifyKey = await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'RS256');
  const users = new Map<string, FakeUser>();
  const members = new Map<string, Set<string>>();
  const requests: FakeGoogle['requests'] = [];
  const issued = new Map<string, { sub: string; until: number }>();
  const hidden = new Map<string, number>();
  let throttled = 0;
  const reset = () => {
    users.clear();
    members.clear();
    requests.length = 0;
    issued.clear();
    hidden.clear();
    throttled = 0;
    for (const g of GROUPS) members.set(g.email, new Set());
    const admin: FakeUser = {
      id: '100000000000000000001',
      primaryEmail: SEED.adminEmail,
      name: { givenName: 'IT', familyName: 'Admin' },
      suspended: false,
      isAdmin: true,
      orgUnitPath: '/',
      creationTime: new Date(0).toISOString(),
      signOuts: 0,
    };
    users.set(admin.id, admin);
  };
  reset();
  let nextId = 200000000000000000000n;
  const byKey = (key: string) =>
    users.get(key) ?? [...users.values()].find((u) => u.primaryEmail === key.toLowerCase());
  const tokenUrlPath = '/token';

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
      res.end(json === undefined ? '' : JSON.stringify(json));
    };
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    try {
      if (path.startsWith('/_fake/')) {
        const body = raw ? JSON.parse(raw) : {};
        if (path === '/_fake/state')
          return send(200, {
            users: [...users.values()].map((u) => ({
              ...view(u),
              hadPassword: Boolean(u.password),
              signOuts: u.signOuts,
            })),
            groups: Object.fromEntries([...members].map(([g, m]) => [g, [...m].sort()])),
            requests,
          });
        if (path === '/_fake/reset') return (reset(), send(200, { ok: true }));
        if (path === '/_fake/throttle') return ((throttled = Number(body.n ?? 1)), send(200, { ok: true }));
        if (path === '/_fake/hide')
          return (hidden.set(String(body.email).toLowerCase(), Number(body.n ?? 1)), send(200, { ok: true }));
        return send(404, { error: 'not found' });
      }

      if (req.method === 'POST' && path === tokenUrlPath) {
        const form = new URLSearchParams(raw);
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer')
          return send(400, { error: 'unsupported_grant_type', error_description: 'Invalid grant_type' });
        let claims: any;
        try {
          ({ payload: claims } = await jwtVerify(form.get('assertion') ?? '', verifyKey, {
            audience: `${baseOf()}${tokenUrlPath}`,
            issuer: SEED.serviceAccountEmail,
            algorithms: ['RS256'],
          }));
        } catch (error) {
          return send(400, { error: 'invalid_grant', error_description: `Invalid JWT: ${(error as Error).message}` });
        }
        if (Number(claims.exp) - Number(claims.iat) > 3600)
          return send(400, {
            error: 'invalid_grant',
            error_description: 'Invalid JWT: Token must be a short-lived token',
          });
        const scopes = String(claims.scope ?? '').split(' ');
        if (!claims.sub || !SEED.admins.includes(String(claims.sub)) || !SCOPES.every((s) => scopes.includes(s)))
          return send(401, {
            error: 'unauthorized_client',
            error_description:
              'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.',
          });
        const token = `ya29.fake-${randomUUID()}`;
        issued.set(token, { sub: String(claims.sub), until: Date.now() + 3600_000 });
        return send(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
      }

      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, body });
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const session = bearer ? issued.get(bearer) : undefined;
      if (!session || session.until < Date.now()) return send(401, gError(401, 'authError', 'Invalid Credentials'));
      if (throttled > 0) {
        throttled--;
        return send(429, gError(429, 'rateLimitExceeded', 'Rate Limit Exceeded'));
      }
      const api = '/admin/directory/v1';
      if (!path.startsWith(api)) return send(404, gError(404, 'notFound', 'Not Found'));
      const p = path.slice(api.length);

      if (req.method === 'GET' && p === '/users') {
        if (!url.searchParams.get('customer') && !url.searchParams.get('domain'))
          return send(400, gError(400, 'badRequest', 'Bad Request'));
        const query = url.searchParams.get('query') ?? '';
        let list = [...users.values()];
        const ext = /externalId[=:]'?([^'\s]+)'?/.exec(query)?.[1];
        const email = /email[=:]'?([^'\s]+)'?/.exec(query)?.[1];
        if (ext) list = list.filter((u) => u.externalIds?.some((e) => e.value === ext));
        if (email) list = list.filter((u) => u.primaryEmail === email.toLowerCase());
        const max = Number(url.searchParams.get('maxResults') ?? 100);
        const page = list.slice(0, max).map(view);
        return send(200, { kind: 'admin#directory#users', ...(page.length && { users: page }) });
      }
      if (req.method === 'POST' && p === '/users') {
        const email = String(body?.primaryEmail ?? '').toLowerCase();
        if (!email.endsWith(`@${DOMAIN}`))
          return send(400, gError(400, 'invalid', 'Invalid Input: primary_user_email'));
        if (!body?.name?.givenName || !body?.name?.familyName)
          return send(400, gError(400, 'required', 'Invalid Input: name'));
        if (!body?.password || String(body.password).length < 8)
          return send(400, gError(400, 'invalid', 'Invalid Password'));
        if (body?.isAdmin) return send(400, gError(400, 'invalid', 'isAdmin is read-only on insert'));
        if (byKey(email)) return send(409, gError(409, 'duplicate', 'Entity already exists.'));
        const user: FakeUser = {
          id: String(nextId++),
          primaryEmail: email,
          name: { givenName: body.name.givenName, familyName: body.name.familyName },
          suspended: Boolean(body.suspended),
          isAdmin: false,
          orgUnitPath: body.orgUnitPath ?? '/',
          ...(body.externalIds && { externalIds: body.externalIds }),
          ...(body.organizations && { organizations: body.organizations }),
          ...(body.relations && { relations: body.relations }),
          creationTime: new Date().toISOString(),
          password: body.password,
          signOuts: 0,
        };
        users.set(user.id, user);
        return send(200, view(user));
      }
      const signOut = /^\/users\/([^/]+)\/signOut$/.exec(p);
      if (req.method === 'POST' && signOut) {
        const user = byKey(decodeURIComponent(signOut[1]));
        if (!user) return send(404, gError(404, 'notFound', 'Resource Not Found: userKey'));
        user.signOuts++;
        return send(204, undefined);
      }
      const one = /^\/users\/([^/]+)$/.exec(p);
      if (one) {
        const user = byKey(decodeURIComponent(one[1]));
        if (!user) return send(404, gError(404, 'notFound', 'Resource Not Found: userKey'));
        if (req.method === 'GET') return send(200, view(user));
        if (req.method === 'PATCH' || req.method === 'PUT') {
          if (body?.isAdmin !== undefined) return send(400, gError(400, 'invalid', 'Use makeAdmin'));
          if (body?.primaryEmail) {
            const email = String(body.primaryEmail).toLowerCase();
            if (!email.endsWith(`@${DOMAIN}`))
              return send(400, gError(400, 'invalid', 'Invalid Input: primary_user_email'));
            const other = byKey(email);
            if (other && other.id !== user.id) return send(409, gError(409, 'duplicate', 'Entity already exists.'));
            for (const set of members.values()) if (set.delete(user.primaryEmail)) set.add(email);
            user.primaryEmail = email;
          }
          for (const key of ['name', 'suspended', 'externalIds', 'organizations', 'relations', 'orgUnitPath'] as const)
            if (body?.[key] !== undefined) (user as any)[key] = body[key];
          return send(200, view(user));
        }
      }
      if (req.method === 'GET' && p === '/groups') {
        const member = (url.searchParams.get('userKey') ?? '').toLowerCase();
        const user = member ? byKey(member) : undefined;
        if (member && !user) return send(404, gError(404, 'notFound', 'Resource Not Found: userKey'));
        const list = GROUPS.filter((g) => !user || members.get(g.email)?.has(user.primaryEmail));
        return send(200, {
          kind: 'admin#directory#groups',
          ...(list.length && { groups: list.map((g) => ({ kind: 'admin#directory#group', ...g })) }),
        });
      }
      const groupMembers = /^\/groups\/([^/]+)\/members(?:\/([^/]+))?$/.exec(p);
      if (groupMembers) {
        const group = decodeURIComponent(groupMembers[1]).toLowerCase();
        const set = members.get(group);
        if (!set) return send(404, gError(404, 'notFound', 'Resource Not Found: groupKey'));
        if (req.method === 'POST' && !groupMembers[2]) {
          const email = String(body?.email ?? '').toLowerCase();
          const hide = hidden.get(email) ?? 0;
          if (hide > 0) {
            hidden.set(email, hide - 1);
            return send(404, gError(404, 'notFound', 'Resource Not Found: memberKey'));
          }
          const user = byKey(email);
          if (!user) return send(404, gError(404, 'notFound', 'Resource Not Found: memberKey'));
          if (set.has(user.primaryEmail)) return send(409, gError(409, 'duplicate', 'Member already exists.'));
          set.add(user.primaryEmail);
          return send(200, {
            kind: 'admin#directory#member',
            email: user.primaryEmail,
            role: body?.role ?? 'MEMBER',
            type: 'USER',
            status: 'ACTIVE',
          });
        }
        if (req.method === 'DELETE' && groupMembers[2]) {
          const email = decodeURIComponent(groupMembers[2]).toLowerCase();
          if (!set.delete(email)) return send(404, gError(404, 'notFound', 'Resource Not Found: memberKey'));
          return send(204, undefined);
        }
      }
      return send(404, gError(404, 'notFound', 'Not Found'));
    } catch (error) {
      return send(500, gError(500, 'backendError', (error as Error).message));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  const baseOf = () => url;
  return {
    url,
    keyFile: { type: 'service_account', client_email: SEED.serviceAccountEmail, private_key: pkcs8 },
    users,
    members,
    requests,
    throttle: (n) => {
      throttled = n;
    },
    hide: (email, n) => {
      hidden.set(email.toLowerCase(), n);
    },
    reset,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeGoogle(Number(process.env.FAKE_GOOGLE_PORT ?? 57995));
  // Where the installer (e2e/landflow/install.ts) reads the key file from by default.
  const out = process.env.FAKE_GOOGLE_KEY_OUT ?? join(tmpdir(), 'landbright-fake-google-key.json');
  if (out)
    writeFileSync(out, JSON.stringify({ ...fake.keyFile, token_uri: `${fake.url}/token` }, null, 2), { mode: 0o600 });
  console.info(
    `fake Google on ${fake.url} (token URL ${fake.url}/token; service account ${SEED.serviceAccountEmail}, acting as ${SEED.adminEmail})${out ? `; key file at ${out}` : ''}`,
  );
}
