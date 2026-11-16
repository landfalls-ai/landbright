/**
 * Google's Admin SDK Directory API, the part the Google Directory node uses, with a service account: an RS256 JWT
 * exchanged for an access token (the JWT bearer grant), acting as an administrator through domain-wide delegation
 * (`sub`) or as itself when it holds an admin role. Tokens are cached in memory until a minute before they expire.
 *
 * Retries: 429, 503 and the rate-limit 403s wait 2^n s plus jitter and try again, three times at most. Every other
 * failure is a GoogleError carrying Google's status, reason and message, branched on by status and reason only.
 */
import { createHash, randomInt } from 'node:crypto';
import { NodeOperationError, type JsonObject, type TracedFetch } from '@landflow/sdk';
import { importPKCS8, SignJWT } from 'jose';

export const DEFAULT_BASE_URL = 'https://admin.googleapis.com';
export const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.group.member',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
];
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

export interface GoogleCredentials extends JsonObject {
  serviceAccountEmail: string;
  privateKey: string;
  adminEmail: string;
  customer: string;
  baseUrl: string;
  tokenUrl: string;
}

export interface ApiContext {
  http: TracedFetch;
  signal?: AbortSignal;
  /** Waits between retries (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Google's answers, read where used
export type Body = Record<string, any>;

const TIMEOUT_MS = 30_000;
const EARLY_S = 60;
const RETRIES = 3;
const RATE_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'quotaExceeded']);

const trim = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/\/+$/, '');

export class GoogleError extends NodeOperationError {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    message: string,
    description?: string,
  ) {
    super(message, description ? { description } : {});
  }
}

/**
 * The key's PEM from what was pasted: the PEM itself, with literal `\n`s, on one line, or the whole JSON key file.
 * Also the email, when the JSON file was pasted and the email field left empty.
 */
export function readKey(credentials: GoogleCredentials): { email: string; pem: string } {
  let raw = String(credentials.privateKey ?? '').trim();
  let email = String(credentials.serviceAccountEmail ?? '').trim();
  if (raw.startsWith('{')) {
    try {
      const file = JSON.parse(raw) as { private_key?: string; client_email?: string };
      raw = String(file.private_key ?? '');
      email ||= String(file.client_email ?? '');
    } catch {
      throw new NodeOperationError('The private key looks like a JSON key file but is not valid JSON');
    }
  }
  raw = raw.replace(/\\n/g, '\n');
  const body = /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/.exec(raw)?.[1];
  if (!body)
    throw new NodeOperationError(
      'The private key must be the PKCS #8 PEM ("-----BEGIN PRIVATE KEY-----…") from the JSON key file',
    );
  const b64 = body.replace(/\s+/g, '');
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  if (!email) throw new NodeOperationError('The credential needs the service account email (client_email)');
  return { email, pem };
}

interface Cached {
  token: string;
  until: number;
}
const tokens = new Map<string, Cached>();
export const clearTokens = () => tokens.clear();

const signalOf = (api: ApiContext) =>
  api.signal ? AbortSignal.any([api.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

async function send(api: ApiContext, url: string, init: RequestInit, what: string) {
  let response: Response;
  try {
    response = await api.http(url, { ...init, signal: signalOf(api) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new GoogleError(0, undefined, `${what} failed: ${(error as Error).message}${cause ? ` (${cause})` : ''}`);
  }
  const text = await response.text();
  let body: Body | undefined;
  try {
    body = text ? (JSON.parse(text) as Body) : undefined;
  } catch {
    body = undefined;
  }
  return { status: response.status, ok: response.ok, body, text };
}

/** An access token for the directory scopes, as the administrator when one is named. */
export async function accessToken(api: ApiContext, credentials: GoogleCredentials): Promise<string> {
  const { email, pem } = readKey(credentials);
  const sub = String(credentials.adminEmail ?? '').trim();
  const tokenUrl = trim(credentials.tokenUrl) || DEFAULT_TOKEN_URL;
  const key = createHash('sha256').update(`${email}\n${sub}\n${tokenUrl}\n${pem}`).digest('hex');
  const cached = tokens.get(key);
  if (cached && cached.until > Date.now()) return cached.token;

  let signing: CryptoKey;
  try {
    signing = await importPKCS8(pem, 'RS256');
  } catch (error) {
    throw new NodeOperationError(`The private key could not be read: ${(error as Error).message}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ scope: SCOPES.join(' ') })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(email)
    .setAudience(tokenUrl)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600);
  // `sub`: the administrator to act as (domain-wide delegation); without it the service account acts as itself.
  if (sub) jwt.setSubject(sub);
  const assertion = await jwt.sign(signing);
  const response = await send(
    api,
    tokenUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: JWT_BEARER, assertion }).toString(),
    },
    'Google token request',
  );
  if (!response.ok || typeof response.body?.access_token !== 'string') {
    const error = String(response.body?.error ?? '');
    const reason =
      response.body?.error_description ?? (error || response.text.slice(0, 200) || `HTTP ${response.status}`);
    throw new GoogleError(
      response.status,
      error || undefined,
      `Google refused the service account: ${reason}`,
      error === 'unauthorized_client'
        ? `Authorize the service account's client ID for ${SCOPES.map((s) => s.split('/').pop()).join(', ')} in the Admin console (Security → Access and data control → API controls → Manage domain-wide delegation), and name a Workspace administrator in Act As. A new grant can take a while to apply.`
        : error === 'invalid_grant'
          ? "Check the service account email and that the key hasn't been deleted; Act As must be a user of the Workspace."
          : undefined,
    );
  }
  const lifetime = Number(response.body.expires_in ?? 3600);
  tokens.set(key, { token: response.body.access_token, until: Date.now() + Math.max(0, lifetime - EARLY_S) * 1000 });
  return response.body.access_token;
}

const HINTS: Record<number, string> = {
  401: 'Google refused the token: check the credential (Test connection).',
  403: "The administrator the service account acts as may not do this, or the Admin SDK API isn't enabled in the service account's Cloud project.",
  404: 'Google has no such user or group (a new account can take a moment to appear).',
};

const reasonOf = (body: Body | undefined): string | undefined =>
  body?.error?.errors?.[0]?.reason ?? body?.error?.status;
const isRateLimited = (status: number, reason?: string) =>
  status === 429 || status === 503 || (status === 403 && reason !== undefined && RATE_REASONS.has(reason));

/** A Directory API call (`path` from `/admin/directory/v1`); the parsed answer, or a GoogleError. */
export async function directory(
  api: ApiContext,
  credentials: GoogleCredentials,
  method: string,
  path: string,
  body?: JsonObject,
): Promise<Body | undefined> {
  const url = `${trim(credentials.baseUrl) || DEFAULT_BASE_URL}/admin/directory/v1${path}`;
  const sleep = api.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(api, credentials);
    const response = await send(
      api,
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body && { 'content-type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
      },
      `Google Directory ${method} ${path.split('?')[0]}`,
    );
    if (response.ok) return response.body;
    const reason = reasonOf(response.body);
    if (isRateLimited(response.status, reason) && attempt < RETRIES) {
      await sleep(2 ** attempt * 1000 + randomInt(0, 1000));
      continue;
    }
    const message = response.body?.error?.message ?? (response.text.slice(0, 200) || `HTTP ${response.status}`);
    throw new GoogleError(
      response.status,
      reason,
      `Google Directory API error ${response.status}${reason ? ` (${reason})` : ''}: ${message}`,
      HINTS[response.status],
    );
  }
}

/** The customer parameter: `my_customer` unless the credential names one. */
export const customerOf = (credentials: GoogleCredentials) =>
  String(credentials.customer ?? '').trim() || 'my_customer';

/** The cheapest authenticated call: one user of the customer. */
export async function checkCredentials(api: ApiContext, credentials: GoogleCredentials): Promise<number> {
  const body = await directory(
    api,
    credentials,
    'GET',
    `/users?customer=${encodeURIComponent(customerOf(credentials))}&maxResults=1`,
  );
  return Array.isArray(body?.users) ? body.users.length : 0;
}
