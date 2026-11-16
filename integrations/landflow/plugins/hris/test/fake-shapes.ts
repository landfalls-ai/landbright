/* eslint-disable @typescript-eslint/no-explicit-any -- a fake server reads whatever it is sent */
/**
 * A fake Shapes: Shapes' GraphQL API as its public schema describes it (test/shapes-schema.graphql, executed with
 * graphql-js, so a query the real API would reject fails here too), tokens that behave as Shapes documents them (an
 * access token for 15 minutes; `refreshToken` spends the refresh token it is sent and answers a new pair), and
 * `deliver()`, which sends a workflow webhook signed the way Shapes signs it. Fictitious people and fake secrets only:
 * there is no Shapes account here.
 *
 *   pnpm --filter @landbright/plugin-hris fake-shapes     # FAKE_SHAPES_PORT (default 57996), 127.0.0.1
 *
 * For a live check: GET /_fake/state; POST /_fake/employees {id, …} adds or changes an employee (their values' updatedAt
 * becomes now); POST /_fake/deliver {url, employeeId, contexts?} sends a signed webhook to `url`; POST /_fake/expire
 * ends every access token; POST /_fake/throttle {n}.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSchema, graphql, GraphQLError } from 'graphql';
import { shapesSignature } from '../src/shapes';

export const SHAPES_SEED = {
  refreshToken: 'fake-shapes-refresh-token-0',
  webhookSecret: 'fake-shapes-webhook-secret-0123456789',
  systemUser: { id: 'u-system', email: 'hr-sync@landbright.test' },
};

export const schema = buildSchema(readFileSync(new URL('./shapes-schema.graphql', import.meta.url), 'utf8'));

export interface FakeShapesEmployee {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  department?: string | null;
  team?: string | null;
  job?: string | null;
  office?: string | null;
  managerId?: string | null;
  startDate?: string | null;
  terminationDate?: string | null;
}

/** Fictitious people of a fictitious company. Ids ascend, as Shapes pages by id. */
export const SHAPES_EMPLOYEES: FakeShapesEmployee[] = [
  {
    id: '1001',
    firstName: 'Maya',
    lastName: 'Cohen',
    email: 'maya.cohen@landbright.test',
    department: 'Engineering',
    job: 'Engineering Manager',
    office: 'Tel Aviv',
    startDate: '2023-01-15',
  },
  {
    id: '1002',
    firstName: 'Lior',
    lastName: 'Ben Ami',
    email: 'lior.benami@landbright.test',
    department: 'Engineering',
    job: 'Backend Engineer',
    office: 'Tel Aviv',
    managerId: '1001',
    startDate: '2026-11-23',
  },
];

/** The account's field types: one per context the plugin reads (ids as Shapes would have them, made up). */
const FIELD_TYPES = [
  ['ft-first', 'first_name', 'text', 'First name'],
  ['ft-last', 'last_name', 'text', 'Last name'],
  ['ft-email', 'email', 'employee_email', 'Work email'],
  ['ft-dept', 'department', 'single_select', 'Department'],
  ['ft-team', 'team', 'team', 'Team'],
  ['ft-job', 'job', 'job', 'Job title'],
  ['ft-office', 'office', 'office', 'Office'],
  ['ft-manager', 'reports_to', 'reports_to', 'Reports to'],
  ['ft-start', 'start_date', 'start_date', 'Start date'],
  ['ft-end', 'termination_date', 'termination_date', 'Termination date'],
].map(([id, context, fieldType, fieldName]) => ({
  id,
  context,
  fieldType,
  fieldName,
  data: null,
  isEffectiveDated: false,
  subcategory: null,
}));

const ids = (name: string | null | undefined) => (name ? `id-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : null);

export interface FakeShapes {
  url: string;
  /** What the credential points at: `${url}/v1`. */
  baseUrl: string;
  employees: Map<string, FakeShapesEmployee>;
  /** context → updatedAt, per employee */
  updated: Map<string, Record<string, string>>;
  requests: Array<{ operation: string; variables: unknown }>;
  /** Refresh tokens spent so far (in order). */
  refreshes: string[];
  upsert(employee: Partial<FakeShapesEmployee> & { id: string }): FakeShapesEmployee;
  expireAccessTokens(): void;
  throttle(n: number): void;
  reset(): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const today = () => new Date().toISOString().slice(0, 10);
function workStatus(e: FakeShapesEmployee): string {
  if (e.terminationDate && e.terminationDate < today()) return 'terminated';
  if (e.startDate && e.startDate > today()) return 'pending_arrival';
  if (e.terminationDate) return 'pending_termination';
  return 'active';
}

/** A workflow webhook body as Shapes sends it (schema version 2), with the named contexts' values. */
export function shapesDelivery(fake: FakeShapes, employeeId: string, contexts: string[] = ['start_date']) {
  const values = valuesOf(fake, employeeId).filter((v) => contexts.includes(v.employeeFieldType.context));
  return {
    schemaVersion: 2,
    timestamp: Date.now(),
    definition: { id: 'wf-1', name: 'Tell Landbright' },
    run: { id: randomUUID() },
    action: { id: 'act-1' },
    employee: {
      id: employeeId,
      employeeFieldValues: values.map((v) => ({
        fieldValue: v.fieldValue,
        textValue: v.textValue,
        employeeFieldType: {
          id: v.employeeFieldType.id,
          fieldName: v.employeeFieldType.fieldName,
          fieldType: v.employeeFieldType.fieldType,
          context: v.employeeFieldType.context,
        },
      })),
    },
  };
}

/** Send a delivery to a webhook URL, signed as Shapes signs it. */
export async function deliverShapes(
  url: string,
  body: Record<string, unknown>,
  secret = SHAPES_SEED.webhookSecret,
  webhookId = `${(body.run as { id: string }).id}:act-1`,
): Promise<{ status: number; body: string }> {
  const raw = JSON.stringify(body);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-id': webhookId,
      'x-webhook-signature': shapesSignature(secret, raw),
      'x-webhook-timestamp': String(body.timestamp),
    },
    body: raw,
  });
  return { status: response.status, body: await response.text() };
}

function valuesOf(fake: Pick<FakeShapes, 'employees' | 'updated'>, employeeId: string) {
  const e = fake.employees.get(employeeId);
  if (!e) return [];
  const stamp = fake.updated.get(employeeId) ?? {};
  const value = (context: string): { fieldValue: unknown; textValue: string | null } | undefined => {
    switch (context) {
      case 'first_name':
        return { fieldValue: e.firstName, textValue: e.firstName };
      case 'last_name':
        return { fieldValue: e.lastName, textValue: e.lastName };
      case 'email':
        return { fieldValue: e.email, textValue: e.email };
      case 'department':
        return e.department ? { fieldValue: ids(e.department), textValue: e.department } : undefined;
      case 'team':
        return e.team ? { fieldValue: ids(e.team), textValue: e.team } : undefined;
      case 'job':
        return e.job ? { fieldValue: ids(e.job), textValue: e.job } : undefined;
      case 'office':
        return e.office ? { fieldValue: ids(e.office), textValue: e.office } : undefined;
      case 'reports_to': {
        const m = e.managerId ? fake.employees.get(e.managerId) : undefined;
        return m ? { fieldValue: m.id, textValue: `${m.firstName} ${m.lastName}` } : undefined;
      }
      case 'start_date':
        return e.startDate ? { fieldValue: e.startDate, textValue: e.startDate } : undefined;
      case 'termination_date':
        return e.terminationDate ? { fieldValue: e.terminationDate, textValue: e.terminationDate } : undefined;
    }
    return undefined;
  };
  return FIELD_TYPES.flatMap((type) => {
    const v = value(type.context);
    return v
      ? [
          {
            id: `fv-${employeeId}-${type.id}`,
            employeeId,
            ...v,
            employeeFieldTypeId: type.id,
            employeeFieldType: type,
            updatedAt: stamp[type.context] ?? '2026-01-01T00:00:00.000Z',
            effectiveDate: null,
            rowId: null,
          },
        ]
      : [];
  });
}

export async function startFakeShapes(port = 0, host = '127.0.0.1'): Promise<FakeShapes> {
  const employees = new Map<string, FakeShapesEmployee>();
  const updated = new Map<string, Record<string, string>>();
  const requests: FakeShapes['requests'] = [];
  const refreshes: string[] = [];
  let accessTokens = new Map<string, number>();
  let refreshTokens = new Set<string>();
  let throttled = 0;
  const fake = { employees, updated } as FakeShapes;

  const reset = () => {
    employees.clear();
    updated.clear();
    requests.length = 0;
    refreshes.length = 0;
    accessTokens = new Map();
    refreshTokens = new Set([SHAPES_SEED.refreshToken]);
    throttled = 0;
    for (const e of SHAPES_EMPLOYEES) employees.set(e.id, { ...e });
  };
  reset();

  const upsert = (input: Partial<FakeShapesEmployee> & { id: string }) => {
    const before = employees.get(input.id);
    const next = { ...(before ?? {}), ...input } as FakeShapesEmployee;
    employees.set(next.id, next);
    const now = new Date().toISOString();
    const stamp = { ...(updated.get(next.id) ?? {}) };
    const map: Record<string, keyof FakeShapesEmployee> = {
      first_name: 'firstName',
      last_name: 'lastName',
      email: 'email',
      department: 'department',
      team: 'team',
      job: 'job',
      office: 'office',
      reports_to: 'managerId',
      start_date: 'startDate',
      termination_date: 'terminationDate',
    };
    for (const [context, key] of Object.entries(map))
      if (!before || (key in input && before[key] !== input[key])) stamp[context] = now;
    updated.set(next.id, stamp);
    return next;
  };

  const view = (e: FakeShapesEmployee) => ({
    id: e.id,
    firstName: e.firstName,
    lastName: e.lastName,
    email: e.email,
    workStatus: workStatus(e),
    profilePictureCdnUrl: null,
    employeeFieldValues: () => valuesOf(fake, e.id),
  });

  const root = {
    me: () => SHAPES_SEED.systemUser,
    employees: (args: any) => {
      let list = [...employees.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      if (args.ids?.length) list = list.filter((e) => args.ids.includes(e.id));
      const f = args.filters ?? {};
      if (f.email?.length)
        list = list.filter((e) => f.email.map((x: string) => x.toLowerCase()).includes(e.email.toLowerCase()));
      if (f.workStatus?.length) list = list.filter((e) => f.workStatus.includes(workStatus(e)));
      if (args.limit !== undefined && (args.limit < 1 || args.limit > 100))
        throw new GraphQLError('limit must be between 1 and 100', { extensions: { code: 'BAD_USER_INPUT' } });
      if (args.afterId) list = list.filter((e) => BigInt(e.id) > BigInt(args.afterId));
      if (args.limit !== undefined || args.afterId) list = list.slice(0, args.limit ?? 100);
      return list.map(view);
    },
    offices: () =>
      [...new Set([...employees.values()].map((e) => e.office).filter(Boolean))].map((n) => ({ id: ids(n), name: n })),
    teams: () =>
      [...new Set([...employees.values()].map((e) => e.team).filter(Boolean))].map((n) => ({ id: ids(n), name: n })),
    jobs: () =>
      [...new Set([...employees.values()].map((e) => e.job).filter(Boolean))].map((n) => ({ id: ids(n), name: n })),
    employeeFieldTypes: () => FIELD_TYPES,
    employeeFieldValues: (args: any) => {
      const f = args.filters ?? {};
      if (
        !args.ids?.length &&
        !f.employeeId?.length &&
        !f.employeeFieldTypeId?.length &&
        !f.fieldTypeContext?.length &&
        !f.updatedAt
      )
        throw new GraphQLError('Give ids or a narrowing filter', { extensions: { code: 'BAD_USER_INPUT' } });
      let list = [...employees.keys()].flatMap((id) => valuesOf(fake, id));
      if (f.employeeId?.length) list = list.filter((v) => f.employeeId.includes(v.employeeId));
      if (f.fieldTypeContext?.length)
        list = list.filter((v) => f.fieldTypeContext.includes(v.employeeFieldType.context));
      if (f.employeeFieldTypeId?.length)
        list = list.filter((v) => f.employeeFieldTypeId.includes(v.employeeFieldTypeId));
      if (f.updatedAt?.start) list = list.filter((v) => v.updatedAt >= f.updatedAt.start);
      if (f.updatedAt?.end) list = list.filter((v) => v.updatedAt <= f.updatedAt.end);
      return list;
    },
    refreshToken: (_args: unknown, context: { refreshToken?: string }) => {
      const old = context.refreshToken ?? '';
      if (!refreshTokens.has(old))
        throw new GraphQLError('Invalid or expired refresh token', { extensions: { code: 'UNAUTHENTICATED' } });
      refreshTokens.delete(old);
      refreshes.push(old);
      const accessToken = `fake-shapes-access-${randomUUID()}`;
      const refreshToken = `fake-shapes-refresh-${randomUUID()}`;
      accessTokens.set(accessToken, Date.now() + 15 * 60_000);
      refreshTokens.add(refreshToken);
      return { accessToken, refreshToken };
    },
  };

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const raw = await readBody(req);
    const path = (req.url ?? '/').split('?')[0];
    try {
      const body = raw ? JSON.parse(raw) : {};
      if (path.startsWith('/_fake/')) {
        if (path === '/_fake/state')
          return send(200, {
            employees: [...employees.values()].map((e) => ({ ...e, workStatus: workStatus(e) })),
            requests,
            refreshes: refreshes.length,
          });
        if (path === '/_fake/employees') return send(200, upsert(body));
        if (path === '/_fake/expire') return (accessTokens.clear(), send(200, { ok: true }));
        if (path === '/_fake/throttle') return ((throttled = Number(body.n ?? 1)), send(200, { ok: true }));
        if (path === '/_fake/reset') return (reset(), send(200, { ok: true }));
        if (path === '/_fake/deliver') {
          if (!body.url || !body.employeeId) return send(400, { error: 'url and employeeId are required' });
          return send(200, await deliverShapes(body.url, shapesDelivery(fake, String(body.employeeId), body.contexts)));
        }
        return send(404, { error: 'not found' });
      }
      if (req.method !== 'POST' || path !== '/v1') return send(404, { errors: [{ message: 'Not found' }] });
      const operation = /(?:query|mutation)\s+(\w+)/.exec(String(body.query ?? ''))?.[1] ?? 'anonymous';
      requests.push({ operation, variables: body.variables });
      const isRefresh = operation === 'Refresh' || /\brefreshToken\b/.test(String(body.query));
      if (!isRefresh) {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const until = bearer ? accessTokens.get(bearer) : undefined;
        if (!until || until < Date.now())
          return send(401, { errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }] });
        if (throttled > 0) {
          throttled--;
          return send(200, {
            errors: [{ message: 'Too many requests', extensions: { code: 'TOO_MANY_REQUESTS', retryAfterSeconds: 0 } }],
            data: null,
          });
        }
      }
      const result = await graphql({
        schema,
        source: String(body.query ?? ''),
        rootValue: root,
        variableValues: body.variables ?? {},
        contextValue: { refreshToken: req.headers['refresh-token'] },
      });
      return send(200, result);
    } catch (error) {
      return send(500, { errors: [{ message: (error as Error).message }] });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    url,
    baseUrl: `${url}/v1`,
    requests,
    refreshes,
    upsert,
    expireAccessTokens: () => accessTokens.clear(),
    throttle: (n: number) => {
      throttled = n;
    },
    reset,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeShapes(Number(process.env.FAKE_SHAPES_PORT ?? 57996));
  console.info(`fake Shapes on ${fake.baseUrl}; deliveries signed with the fake webhook secret`);
}
