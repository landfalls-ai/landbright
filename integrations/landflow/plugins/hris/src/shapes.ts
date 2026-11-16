/**
 * Shapes' public API (GraphQL at https://api.shapes.co/v1; spec 010, research in specs/010-shapes/research.md), the part
 * the Shapes nodes use: employees by id, by email and changed since a time, with the field values a worker needs.
 *
 * Tokens: Shapes' access token lasts 15 minutes and its refresh token 7 days, and every refresh spends the refresh token
 * it was sent with (`mutation { refreshToken }` with a `Refresh-Token` header answers a new pair). The credential holds
 * the refresh token a person pasted; the plugin keeps the pair it gets back in a token store (a file, mode 600, outside
 * Landflow), keyed by the pasted token, so pasting a new one starts afresh. One plugin process per store: two would
 * spend each other's refresh tokens.
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { NodeOperationError, safeEqual, type JsonObject, type TracedFetch } from '@landflow/sdk';
import { isoDate, type Worker } from './worker';

export const DEFAULT_SHAPES_URL = 'https://api.shapes.co/v1';

export interface ShapesCredentials extends JsonObject {
  baseUrl: string;
  refreshToken: string;
  webhookSecret: string;
}

export interface ApiContext {
  http: TracedFetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Shapes' answers, read where used
type Body = Record<string, any>;

const TIMEOUT_MS = 30_000;
/** A token is renewed this long before it expires. */
const EARLY_MS = 60_000;
const ACCESS_LIFETIME_MS = 15 * 60_000;
/** TOO_MANY_REQUESTS waits at most this long inside a run; longer, the item fails and says when to retry. */
const MAX_WAIT_S = 30;
const RETRIES = 2;

export class ShapesError extends NodeOperationError {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    description?: string,
  ) {
    super(message, description ? { description } : {});
  }
}

const baseOf = (credentials: ShapesCredentials) =>
  (String(credentials.baseUrl ?? '').trim() || DEFAULT_SHAPES_URL).replace(/\/+$/, '');

// ---------------------------------------------------------------- the token store

interface Pair {
  accessToken: string;
  /** ms since the epoch */
  accessUntil: number;
  refreshToken: string;
  refreshedAt: string;
}

/** Where the plugin keeps Shapes' token pairs: SHAPES_TOKEN_STORE, else ~/.config/landbright/shapes-tokens.json. */
export const tokenStorePath = () =>
  process.env.SHAPES_TOKEN_STORE ?? join(homedir(), '.config', 'landbright', 'shapes-tokens.json');

function readStore(path: string): Record<string, Pair> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, Pair>;
  } catch {
    return {};
  }
}

function writeStore(path: string, store: Record<string, Pair>) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** The store's key for a credential: the API and the refresh token as pasted, hashed (never the token itself). */
const keyOf = (credentials: ShapesCredentials) =>
  createHash('sha256')
    .update(`${baseOf(credentials)}\n${String(credentials.refreshToken ?? '').trim()}`)
    .digest('hex');

/** One refresh at a time per credential in this process: two at once would spend the same refresh token. */
const locks = new Map<string, Promise<unknown>>();
function serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const run = before.then(fn, fn);
  locks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/** A JWT's `exp` in ms, when the token is one; else now + 15 minutes. */
function expiryOf(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { exp?: number };
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // not a JWT
  }
  return Date.now() + ACCESS_LIFETIME_MS;
}

const signalOf = (api: ApiContext) =>
  api.signal ? AbortSignal.any([api.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

async function post(api: ApiContext, url: string, headers: Record<string, string>, body: JsonObject) {
  let response: Response;
  try {
    response = await api.http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signalOf(api),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new ShapesError(
      0,
      undefined,
      `Shapes request failed: ${(error as Error).message}${cause ? ` (${cause})` : ''}`,
    );
  }
  const text = await response.text();
  let parsed: Body | undefined;
  try {
    parsed = text ? (JSON.parse(text) as Body) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, ok: response.ok, body: parsed, text };
}

const REFRESH = 'mutation Refresh { refreshToken { accessToken refreshToken } }';
const REFRESH_HINT =
  'Create a new token pair in Shapes (My settings → API tokens) and paste its refresh token into the credential. A refresh token lasts 7 days unused, and each refresh spends it: don’t share one with another tool.';

/** Spend `refreshToken` for a new pair. */
async function refresh(api: ApiContext, credentials: ShapesCredentials, refreshToken: string): Promise<Pair> {
  const response = await post(api, baseOf(credentials), { 'refresh-token': refreshToken }, { query: REFRESH });
  const pair = response.body?.data?.refreshToken;
  if (!response.ok || !pair?.accessToken || !pair?.refreshToken) {
    const error = response.body?.errors?.[0];
    throw new ShapesError(
      response.status,
      error?.extensions?.code,
      `Shapes refused the refresh token: ${error?.message ?? (response.text.slice(0, 200) || `HTTP ${response.status}`)}`,
      REFRESH_HINT,
    );
  }
  return {
    accessToken: String(pair.accessToken),
    accessUntil: expiryOf(String(pair.accessToken)),
    refreshToken: String(pair.refreshToken),
    refreshedAt: new Date().toISOString(),
  };
}

/**
 * A current access token: the stored one while it lasts, else a refresh with the stored refresh token (the pasted one
 * the first time). `force` refreshes even when the stored token looks current (Shapes said it isn't).
 */
export function accessToken(api: ApiContext, credentials: ShapesCredentials, force = false): Promise<string> {
  const seed = String(credentials.refreshToken ?? '').trim();
  if (!seed)
    throw new NodeOperationError('The Shapes credential needs a refresh token (Shapes → My settings → API tokens)');
  const key = keyOf(credentials);
  return serially(key, async () => {
    const path = tokenStorePath();
    const stored = readStore(path)[key];
    if (!force && stored && stored.accessUntil - EARLY_MS > Date.now()) return stored.accessToken;
    const next = await refresh(api, credentials, stored?.refreshToken ?? seed);
    const store = readStore(path);
    store[key] = next;
    writeStore(path, store);
    return next.accessToken;
  });
}

const HINTS: Record<string, string> = {
  FORBIDDEN:
    "The token's user may not read this. Shapes advises a dedicated system user; it must be a Super Admin, or an Admin who covers every employee (work status is shown to admins only).",
  BAD_USER_INPUT: 'Shapes refused the query (a read over 50,000 values, or a page size out of range).',
  TOO_MANY_REQUESTS: 'Shapes is rate limiting this user. Poll no more often than every 15 minutes.',
};

const isAuthError = (status: number, code?: string) =>
  status === 401 || code === 'UNAUTHENTICATED' || code === 'UNAUTHORIZED';

/** A GraphQL call; `data`, or a ShapesError with Shapes' code. An expired token is renewed and the call made again. */
export async function graphql(
  api: ApiContext,
  credentials: ShapesCredentials,
  query: string,
  variables: JsonObject = {},
): Promise<Body> {
  const sleep = api.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let renewed = false;
  let forceRefresh = false;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(api, credentials, forceRefresh);
    forceRefresh = false;
    const response = await post(api, baseOf(credentials), { authorization: `Bearer ${token}` }, { query, variables });
    const error = response.body?.errors?.[0];
    const code: string | undefined = error?.extensions?.code;
    if (response.ok && response.body?.data && !error) return response.body.data;
    if (isAuthError(response.status, code) && !renewed) {
      renewed = true;
      forceRefresh = true;
      continue;
    }
    if (code === 'TOO_MANY_REQUESTS' && attempt < RETRIES) {
      const after = Number(error?.extensions?.retryAfterSeconds ?? 60);
      if (after <= MAX_WAIT_S) {
        await sleep(Math.max(1, after) * 1000);
        continue;
      }
    }
    throw new ShapesError(
      response.status,
      code,
      `Shapes API error${code ? ` ${code}` : ` ${response.status}`}: ${error?.message ?? (response.text.slice(0, 200) || `HTTP ${response.status}`)}`,
      code ? HINTS[code] : undefined,
    );
  }
}

// ---------------------------------------------------------------- employees

/** The field contexts a worker is made of (EmployeeFieldTypeContext). */
export const WORKER_CONTEXTS = [
  'department',
  'team',
  'job',
  'office',
  'reports_to',
  'start_date',
  'termination_date',
] as const;
/** Changes to these make an employee worth reading again (names and email are field values too). */
export const CHANGE_CONTEXTS = [...WORKER_CONTEXTS, 'first_name', 'last_name', 'email'] as const;

const EMPLOYEE = 'id firstName lastName email workStatus';
const VALUES = 'employeeId fieldValue textValue updatedAt employeeFieldType { context fieldType }';

export interface ShapesEmployee {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  workStatus: string | null;
}
export interface FieldValue {
  employeeId: string;
  fieldValue: unknown;
  textValue: string | null;
  updatedAt?: string;
  employeeFieldType?: { context?: string; fieldType?: string };
}

const chunks = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/** Employees by id, and the worker fields of each (one batch of values per 100 employees, as Shapes advises). */
export async function employeesWithValues(
  api: ApiContext,
  credentials: ShapesCredentials,
  ids: string[],
): Promise<Array<{ employee: ShapesEmployee; values: FieldValue[] }>> {
  const out: Array<{ employee: ShapesEmployee; values: FieldValue[] }> = [];
  for (const batch of chunks([...new Set(ids)], 100)) {
    const data = await graphql(
      api,
      credentials,
      `query Workers($ids: [ID], $values: EmployeeFieldValueFilters) {
        employees(ids: $ids) { ${EMPLOYEE} }
        employeeFieldValues(filters: $values) { ${VALUES} }
      }`,
      { ids: batch, values: { employeeId: batch, fieldTypeContext: [...WORKER_CONTEXTS] } },
    );
    const values = (data.employeeFieldValues ?? []) as FieldValue[];
    for (const employee of (data.employees ?? []) as ShapesEmployee[])
      if (employee) out.push({ employee, values: values.filter((v) => v?.employeeId === employee.id) });
  }
  return out;
}

/** The employees with this work email (Shapes' email filter). */
export async function idsByEmail(api: ApiContext, credentials: ShapesCredentials, email: string): Promise<string[]> {
  const data = await graphql(
    api,
    credentials,
    'query ByEmail($email: [String]) { employees(filters: { email: $email }) { id } }',
    {
      email: [email.trim().toLowerCase()],
    },
  );
  return ((data.employees ?? []) as Array<{ id: string }>).map((e) => e.id);
}

/** Ids of employees whose worker fields changed since `since` (ISO), from the field values' `updatedAt`. */
export async function changedSince(api: ApiContext, credentials: ShapesCredentials, since: string): Promise<string[]> {
  const data = await graphql(
    api,
    credentials,
    'query Changed($filters: EmployeeFieldValueFilters) { employeeFieldValues(filters: $filters) { employeeId updatedAt } }',
    { filters: { updatedAt: { start: since }, fieldTypeContext: [...CHANGE_CONTEXTS] } },
  );
  const latest = new Map<string, string>();
  for (const v of (data.employeeFieldValues ?? []) as FieldValue[])
    if (v?.employeeId && (!latest.has(v.employeeId) || String(v.updatedAt) > latest.get(v.employeeId)!))
      latest.set(v.employeeId, String(v.updatedAt ?? ''));
  return [...latest.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([id]) => id);
}

/** The cheapest authenticated call: who the token belongs to. */
export async function whoAmI(api: ApiContext, credentials: ShapesCredentials): Promise<{ id: string; email: string }> {
  const data = await graphql(api, credentials, 'query Me { me { id email } }');
  return data.me as { id: string; email: string };
}

// ---------------------------------------------------------------- workers

const valueOf = (values: FieldValue[], context: string) =>
  values.find((v) => v.employeeFieldType?.context === context && (v.textValue || v.fieldValue != null));
const textOf = (v: FieldValue | undefined): string | null => {
  if (!v) return null;
  const t = (v.textValue ?? '').trim();
  if (t && t !== 'MISSING_INFO') return t;
  return typeof v.fieldValue === 'string' && v.fieldValue.trim() ? v.fieldValue.trim() : null;
};
/** An entity reference's id (`reports_to`): a scalar, or the first of a list. */
const refOf = (v: FieldValue | undefined): string | null => {
  const raw = Array.isArray(v?.fieldValue) ? v?.fieldValue[0] : v?.fieldValue;
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
};
/** The manager's employee id, for looking up their email. */
export const managerIdOf = (values: FieldValue[]) => refOf(valueOf(values, 'reports_to'));

/** A Shapes employee and their field values as a worker. `managerEmail` comes from reading the manager. */
export function workerFromShapes(employee: ShapesEmployee, values: FieldValue[], managerEmail: string | null): Worker {
  if (!employee?.id) throw new Error('The Shapes employee has no id');
  const givenName = employee.firstName?.trim() || null;
  const familyName = employee.lastName?.trim() || null;
  const date = (context: string) => {
    const v = valueOf(values, context);
    return isoDate(v?.fieldValue) ?? isoDate(v?.textValue);
  };
  return {
    source: 'shapes',
    sourceId: String(employee.id),
    email: employee.email?.trim().toLowerCase() || null,
    givenName,
    familyName,
    displayName: [givenName, familyName].filter(Boolean).join(' ') || null,
    department: textOf(valueOf(values, 'department')) ?? textOf(valueOf(values, 'team')),
    title: textOf(valueOf(values, 'job')),
    site: textOf(valueOf(values, 'office')),
    managerEmail: managerEmail?.toLowerCase() ?? null,
    startDate: date('start_date'),
    endDate: date('termination_date'),
    status: employee.workStatus?.toLowerCase() ?? null,
  };
}

/** Employees by id as workers, their managers' emails read in one more batch. */
export async function workersByIds(api: ApiContext, credentials: ShapesCredentials, ids: string[]): Promise<Worker[]> {
  const found = await employeesWithValues(api, credentials, ids);
  const managerIds = [...new Set(found.map((f) => managerIdOf(f.values)).filter((id): id is string => Boolean(id)))];
  const emails = new Map<string, string>();
  for (const batch of chunks(managerIds, 100)) {
    const data = await graphql(api, credentials, 'query Managers($ids: [ID]) { employees(ids: $ids) { id email } }', {
      ids: batch,
    });
    for (const m of (data.employees ?? []) as Array<{ id: string; email: string }>) if (m) emails.set(m.id, m.email);
  }
  return found.map(({ employee, values }) =>
    workerFromShapes(employee, values, emails.get(managerIdOf(values) ?? '') ?? null),
  );
}

// ---------------------------------------------------------------- webhooks

/** Shapes' signature: HMAC-SHA256 of the raw body with the webhook's secret, hex (Shapes' example). */
export function shapesSignature(secret: string, body: Buffer | string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Whether `X-Webhook-Signature` signs the body. Hex as Shapes documents, also with a `sha256=` prefix or in base64:
 * the format isn't confirmed against a live account yet (research, "not published").
 */
export function verifyShapesSignature(secret: string, body: Buffer | string, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const given = signature.trim().replace(/^sha256=/i, '');
  const mac = createHmac('sha256', secret).update(body).digest();
  return safeEqual(given.toLowerCase(), mac.toString('hex')) || safeEqual(given, mac.toString('base64'));
}
