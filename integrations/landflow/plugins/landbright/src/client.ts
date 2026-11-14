/**
 * Landbright's machine API (`/api/v1` on the control plane) with an application's client credentials: a token from
 * `{issuer}/token` with `resource=urn:landbright:api`, kept until a minute before it expires.
 */
import { createHash } from 'node:crypto';
import { NodeOperationError, type JsonObject, type TracedFetch } from '@landflow/sdk';

export const MACHINE_API_RESOURCE = 'urn:landbright:api';

export interface LandbrightCredentials extends JsonObject {
  controlUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated; Landbright grants only the scopes asked for (and the application has). */
  scopes: string;
}

export const DEFAULT_SCOPES = 'directory:read directory:write';

export interface ApiContext {
  http: TracedFetch;
  signal?: AbortSignal;
}

const TIMEOUT_MS = 30_000;
const EARLY_S = 60;

/** A parsed JSON answer, read loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers from another service, checked where read
type Body = Record<string, any>;

const trim = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/\/+$/, '');

interface Cached {
  token: string;
  until: number;
}
const tokens = new Map<string, Cached>();

/** Forget every cached token (tests). */
export const clearTokens = () => tokens.clear();

export class LandbrightError extends NodeOperationError {
  constructor(
    readonly status: number,
    message: string,
    description?: string,
  ) {
    super(message, description ? { description } : {});
  }
}

const signalOf = (api: ApiContext) =>
  api.signal ? AbortSignal.any([api.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

async function send(
  api: ApiContext,
  url: string,
  init: RequestInit,
  what: string,
): Promise<{ status: number; ok: boolean; body: Body | undefined; text: string }> {
  let response: Response;
  try {
    response = await api.http(url, { ...init, signal: signalOf(api) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new LandbrightError(0, `${what} failed: ${(error as Error).message}${cause ? ` (${cause})` : ''}`);
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

/** An access token for the machine API (cached per issuer, client and secret). */
export async function accessToken(api: ApiContext, credentials: LandbrightCredentials): Promise<string> {
  const issuer = trim(credentials.issuer);
  const clientId = String(credentials.clientId ?? '').trim();
  const secret = String(credentials.clientSecret ?? '');
  if (!issuer || !clientId || !secret)
    throw new NodeOperationError('The Landbright credential needs the issuer, a client ID and its secret');
  const scope = String(credentials.scopes ?? '').trim() || DEFAULT_SCOPES;
  const key = createHash('sha256').update(`${issuer}\n${clientId}\n${secret}\n${scope}`).digest('hex');
  const cached = tokens.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
  const response = await send(
    api,
    `${issuer}/token`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', resource: MACHINE_API_RESOURCE, scope }).toString(),
    },
    'Landbright token request',
  );
  if (!response.ok || typeof response.body?.access_token !== 'string') {
    const reason =
      response.body?.error_description ??
      response.body?.error ??
      (response.text.slice(0, 200) || `HTTP ${response.status}`);
    throw new LandbrightError(
      response.status,
      `Landbright refused the client credentials: ${reason}`,
      response.body?.error === 'invalid_target'
        ? 'Give the application machine API scopes (Applications → the application → Machine API) and the client credentials grant.'
        : "Check the issuer, the client ID and the secret (Applications → the application in Landbright's console).",
    );
  }
  const lifetime = Number(response.body.expires_in ?? 300);
  tokens.set(key, { token: response.body.access_token, until: Date.now() + Math.max(0, lifetime - EARLY_S) * 1000 });
  return response.body.access_token;
}

const HINTS: Record<number, string> = {
  401: "The token was refused: check the credential's issuer and that control trusts it.",
  403: 'The application lacks a machine API scope this needs (directory:read or directory:write).',
  409: 'Landbright refused the change because of what it already holds (the message says what).',
};

/** A machine API call; the parsed answer, or a LandbrightError carrying Landbright's message. */
export async function call(
  api: ApiContext,
  credentials: LandbrightCredentials,
  method: string,
  path: string,
  body?: JsonObject,
): Promise<JsonObject> {
  const base = trim(credentials.controlUrl);
  if (!base) throw new NodeOperationError('The Landbright credential has no Control URL');
  const token = await accessToken(api, credentials);
  const response = await send(
    api,
    `${base}/api/v1${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
    },
    `Landbright ${method} ${path}`,
  );
  if (!response.ok) {
    const message = response.body?.message ?? response.body?.detail ?? response.body?.title;
    const detail = Array.isArray(message)
      ? message.join('; ')
      : typeof message === 'string'
        ? message
        : response.text.slice(0, 200) || `HTTP ${response.status}`;
    const issues = Array.isArray(response.body?.errors)
      ? ` (${(response.body.errors as Array<{ path?: string[]; message?: string }>).map((e: { path?: string[]; message?: string }) => `${(e.path ?? []).join('.')}: ${e.message}`).join('; ')})`
      : '';
    throw new LandbrightError(
      response.status,
      `Landbright API error ${response.status}: ${detail}${issues}`,
      HINTS[response.status],
    );
  }
  return (response.body ?? {}) as JsonObject;
}
