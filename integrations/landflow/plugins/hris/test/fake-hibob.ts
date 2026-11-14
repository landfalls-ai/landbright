/* eslint-disable @typescript-eslint/no-explicit-any -- a fake server reads whatever it is sent */
/**
 * A fake Bob: the HiBob routes the hris plugin calls (`POST /v1/people/{id or email}`, `POST /v1/people/search`, Basic
 * auth with a service user), answering in Bob's flat machine format with the human-readable names appended, and a
 * `deliver()` that signs an event the way Bob does (base64 HMAC-SHA512 in `Bob-Signature`). Fictitious people and fake
 * secrets only: there is no HiBob tenant here.
 *
 *   pnpm --filter @landbright/plugin-hris fake-hibob     # listens on FAKE_HIBOB_PORT (default 57994), 127.0.0.1
 *
 * For a flow's end-to-end run: GET /_fake/state; POST /_fake/employees {id, …} adds or changes an employee;
 * POST /_fake/deliver {url, type, employeeId, fieldUpdatesIds?} signs and sends an event to `url` and answers with
 * what it got back.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bobSignature } from '../src/hibob';

export const SEED = {
  serviceUserId: 'SERVICE-FAKE-1',
  token: 'fake-hibob-token-0123456789',
  webhookSecret: 'fake-hibob-webhook-secret-0123456789',
  companyId: '640001',
};

export interface FakeEmployee {
  id: string;
  email: string;
  firstName: string;
  surname: string;
  displayName?: string;
  department?: string;
  title?: string;
  site?: string;
  managerEmail?: string;
  startDate?: string;
  terminationDate?: string | null;
  status?: 'Active' | 'Inactive';
  lifecycleStatus?: string;
}

/** Fictitious people of a fictitious company. */
export const EMPLOYEES: FakeEmployee[] = [
  {
    id: '3332883884017713238',
    email: 'noa.barak@landbright.test',
    firstName: 'Noa',
    surname: 'Barak',
    department: 'Engineering',
    title: 'Platform Engineer',
    site: 'Tel Aviv',
    managerEmail: 'maya.cohen@landbright.test',
    startDate: '2026-11-21',
    status: 'Active',
    lifecycleStatus: 'hired',
  },
  {
    id: '3332883884017713239',
    email: 'omer.katz@landbright.test',
    firstName: 'Omer',
    surname: 'Katz',
    department: 'Finance',
    title: 'Controller',
    site: 'London',
    managerEmail: 'dana.shalev@landbright.test',
    startDate: '2024-03-01',
    status: 'Active',
    lifecycleStatus: 'employed',
  },
];

/** List fields have ids in Bob's machine values and names in `humanReadable`. */
const listId = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-id`;

/** An employee in Bob's flat machine format, `humanReadable: "APPEND"`. */
export function machineFormat(employee: FakeEmployee): Record<string, unknown> {
  const list = (name?: string) => (name ? { value: listId(name), humanReadable: name } : { value: null });
  return {
    '/root/id': { value: employee.id },
    '/root/email': { value: employee.email },
    '/root/firstName': { value: employee.firstName },
    '/root/surname': { value: employee.surname },
    '/root/displayName': { value: employee.displayName ?? `${employee.firstName} ${employee.surname}` },
    '/work/department': list(employee.department),
    '/work/title': list(employee.title),
    '/work/site': list(employee.site),
    '/work/reportsTo': {
      value: employee.managerEmail
        ? {
            id: `mgr-${listId(employee.managerEmail)}`,
            email: employee.managerEmail,
            displayName: employee.managerEmail,
          }
        : null,
    },
    '/work/startDate': { value: employee.startDate ?? null },
    '/internal/terminationDate': { value: employee.terminationDate ?? null },
    '/internal/status': { value: employee.status ?? 'Active' },
    '/internal/lifecycleStatus': { value: employee.lifecycleStatus ?? 'employed' },
  };
}

export interface FakeHiBob {
  url: string;
  /** What the plugin's credential points at: `${url}/v1`. */
  baseUrl: string;
  employees: Map<string, FakeEmployee>;
  requests: Array<{ method: string; path: string; body: unknown }>;
  /** The next `n` API calls answer 429 with `Retry-After: 0`. */
  throttle(n: number): void;
  reset(): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** A v2 event as Bob sends it. */
export function bobEvent(
  type: string,
  employeeId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    companyId: SEED.companyId,
    type,
    triggeredBy: 'SERVICE-FAKE-HR',
    triggeredAt: new Date().toISOString(),
    version: 'v2',
    data: { employeeId, ...extra },
  };
}

/** Send an event to a webhook URL, signed as Bob signs it. */
export async function deliver(
  url: string,
  event: Record<string, unknown>,
  secret = SEED.webhookSecret,
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(event);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'bob-signature': bobSignature(secret, body),
      'x-request-id': randomUUID(),
    },
    body,
  });
  return { status: response.status, body: await response.text() };
}

export async function startFakeHiBob(port = 0, host = '127.0.0.1'): Promise<FakeHiBob> {
  const employees = new Map<string, FakeEmployee>();
  const requests: FakeHiBob['requests'] = [];
  let throttled = 0;
  const reset = () => {
    employees.clear();
    for (const employee of EMPLOYEES) employees.set(employee.id, { ...employee });
    requests.length = 0;
    throttled = 0;
  };
  reset();
  const expected = `Basic ${Buffer.from(`${SEED.serviceUserId}:${SEED.token}`).toString('base64')}`;
  const find = (key: string) =>
    employees.get(key) ?? [...employees.values()].find((e) => e.email.toLowerCase() === key.toLowerCase());

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(json));
    };
    const raw = await readBody(req);
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(400, { error: 'invalid JSON' });
    }
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path.startsWith('/_fake/')) {
        if (req.method === 'GET' && path === '/_fake/state')
          return send(200, { employees: [...employees.values()], requests });
        if (req.method === 'POST' && path === '/_fake/employees') {
          if (!body.id) return send(400, { error: 'id is required' });
          const next = { ...(employees.get(body.id) ?? {}), ...body } as FakeEmployee;
          employees.set(next.id, next);
          return send(200, next);
        }
        if (req.method === 'POST' && path === '/_fake/deliver') {
          const { url, type, employeeId, ...extra } = body;
          if (!url || !type || !employeeId) return send(400, { error: 'url, type and employeeId are required' });
          return send(200, await deliver(url, bobEvent(type, employeeId, extra)));
        }
        return send(404, { error: 'not found' });
      }
      requests.push({ method: req.method ?? 'GET', path, body });
      if (req.headers.authorization !== expected) return send(401, { error: 'Unauthorized' });
      if (throttled > 0) {
        throttled--;
        return send(429, { error: 'Too Many Requests' }, { 'retry-after': '0' });
      }
      if (req.method === 'POST' && path === '/v1/people/search') {
        const filter = (body.filters ?? []).find((f: any) => f.fieldPath === 'root.email');
        const wanted = filter ? (filter.values ?? []).map((v: string) => v.toLowerCase()) : null;
        const found = [...employees.values()].filter(
          (e) =>
            (!wanted || wanted.includes(e.email.toLowerCase())) &&
            (body.showInactive === true || (e.status ?? 'Active') === 'Active'),
        );
        return send(200, { employees: found.map(machineFormat) });
      }
      const one = /^\/v1\/people\/([^/]+)$/.exec(path);
      if (req.method === 'POST' && one) {
        const employee = find(decodeURIComponent(one[1]));
        if (!employee) return send(404, { error: `Employee not found` });
        return send(200, { employees: [machineFormat(employee)] });
      }
      return send(404, { error: 'not found' });
    } catch (error) {
      return send(500, { error: (error as Error).message });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  return {
    url,
    baseUrl: `${url}/v1`,
    employees,
    requests,
    throttle: (n) => {
      throttled = n;
    },
    reset,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeHiBob(Number(process.env.FAKE_HIBOB_PORT ?? 57994));
  console.info(
    `fake Bob on ${fake.baseUrl} (service user ${SEED.serviceUserId}); deliveries signed with the fake webhook secret`,
  );
}
