/**
 * HiBob's public API, the part the hris nodes use: read an employee by id or email, and search by email. Basic auth
 * with a service user (`id:token`). A 429 waits `Retry-After` (at most 10 s) and is retried twice.
 */
import { createHmac } from 'node:crypto';
import { NodeOperationError, safeEqual, type JsonObject, type TracedFetch } from '@landflow/sdk';
import { HIBOB_FIELDS } from './worker';

export const DEFAULT_BASE_URL = 'https://api.hibob.com/v1';

export interface HiBobCredentials extends JsonObject {
  baseUrl: string;
  serviceUserId: string;
  token: string;
  webhookSecret: string;
}

export interface ApiContext {
  http: TracedFetch;
  signal?: AbortSignal;
}

const TIMEOUT_MS = 30_000;
const MAX_RETRY_WAIT_S = 10;
const RETRIES = 2;

/** Bob's signature: base64 HMAC-SHA512 of the raw body with the webhook's secret. */
export function bobSignature(secret: string, body: Buffer | string): string {
  return createHmac('sha512', secret).update(body).digest('base64');
}

/** Whether `signature` (the `Bob-Signature` header) signs `body`; constant time. */
export function verifyBobSignature(secret: string, body: Buffer | string, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  return safeEqual(signature.trim(), bobSignature(secret, body));
}

const baseUrl = (credentials: HiBobCredentials) =>
  (String(credentials.baseUrl ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');

function authorization(credentials: HiBobCredentials): string {
  const user = String(credentials.serviceUserId ?? '').trim();
  const token = String(credentials.token ?? '').trim();
  if (!user || !token) throw new NodeOperationError('The HiBob credential needs a Service User ID and Token');
  return `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new NodeOperationError('The execution was canceled while waiting'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => (clearTimeout(timer), reject(new NodeOperationError('The execution was canceled while waiting'))),
      { once: true },
    );
  });

export class HiBobError extends NodeOperationError {
  constructor(
    readonly status: number,
    message: string,
    description?: string,
  ) {
    super(message, description ? { description } : {});
  }
}

const HINTS: Record<number, string> = {
  401: 'HiBob rejected the service user. Check its ID and token (Bob → Settings → Integrations → Service Users).',
  403: 'The service user may not read these fields. Give its permission group access to the employees and the Work, Personal and Lifecycle fields.',
  429: 'HiBob is rate limiting this service user; the call was retried and still refused.',
};

/** POST a JSON body to HiBob; the parsed answer, or a HiBobError. */
async function post(api: ApiContext, credentials: HiBobCredentials, path: string, body: JsonObject): Promise<unknown> {
  const url = `${baseUrl(credentials)}${path}`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      authorization: authorization(credentials),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  };
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await api.http(url, {
        ...init,
        signal: api.signal
          ? AbortSignal.any([api.signal, AbortSignal.timeout(TIMEOUT_MS)])
          : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new HiBobError(0, `HiBob request failed: ${(error as Error).message}${cause ? ` (${cause})` : ''}`);
    }
    const textBody = await response.text();
    if (response.status === 429 && attempt < RETRIES) {
      const after = Number(response.headers.get('retry-after') ?? 1);
      if (after >= 0 && after <= MAX_RETRY_WAIT_S) {
        await wait(Math.ceil(after * 1000), api.signal);
        continue;
      }
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = textBody ? JSON.parse(textBody) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const detail = parsed?.error ?? parsed?.message ?? (textBody.slice(0, 200) || `HTTP ${response.status}`);
      throw new HiBobError(
        response.status,
        `HiBob API error ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
        HINTS[response.status],
      );
    }
    return parsed;
  }
}

const employeesOf = (body: unknown): Record<string, unknown>[] => {
  const list = (body as { employees?: unknown } | undefined)?.employees;
  if (Array.isArray(list)) return list as Record<string, unknown>[];
  if (body && typeof body === 'object' && !Array.isArray(body)) return [body as Record<string, unknown>];
  return [];
};

/** One employee by id or email; undefined when HiBob has none. */
export async function getEmployee(
  api: ApiContext,
  credentials: HiBobCredentials,
  idOrEmail: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await post(api, credentials, `/people/${encodeURIComponent(idOrEmail)}`, {
      fields: HIBOB_FIELDS,
      humanReadable: 'APPEND',
    });
    return employeesOf(body)[0];
  } catch (error) {
    if (error instanceof HiBobError && error.status === 404) return undefined;
    throw error;
  }
}

/** Employees with this email (active ones, or all with `showInactive`). */
export async function searchByEmail(
  api: ApiContext,
  credentials: HiBobCredentials,
  email: string,
  showInactive = false,
): Promise<Record<string, unknown>[]> {
  const body = await post(api, credentials, '/people/search', {
    fields: HIBOB_FIELDS,
    filters: [{ fieldPath: 'root.email', operator: 'equals', values: [email] }],
    humanReadable: 'APPEND',
    showInactive,
  });
  return employeesOf(body);
}

/** The cheapest authenticated call HiBob has: a search that matches nobody. */
export async function checkCredentials(api: ApiContext, credentials: HiBobCredentials): Promise<void> {
  await post(api, credentials, '/people/search', {
    fields: ['root.id'],
    filters: [{ fieldPath: 'root.email', operator: 'equals', values: ['nobody@landflow.invalid'] }],
  });
}
