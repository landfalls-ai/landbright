/**
 * A SCIM 2.0 client (RFC 7644) for one application's server, as small as what Landbright pushes needs: create, read,
 * find by one attribute, patch and delete Users and Groups. Bodies go as `application/json`: every server takes it,
 * and Landfall's parser takes nothing else.
 */

const TIMEOUT_MS = 10_000;

export class ScimError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    /** From `Retry-After`, in milliseconds. */
    readonly retryAfterMs?: number,
    readonly scimType?: string,
  ) {
    super(message);
  }

  /** Worth trying again later as it is: the server or the network, not the request. */
  get transient(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

export interface ScimResource {
  id: string;
  [key: string]: unknown;
}

export interface PatchOp {
  op: 'add' | 'replace' | 'remove';
  path?: string;
  value?: unknown;
}

export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';

/** `userName eq "a@b.c"`, with the value's quotes and backslashes escaped. */
export const eqFilter = (attribute: string, value: string) =>
  `${attribute} eq "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const retryAfter = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

export class ScimClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** One call. Answers the parsed body (or null for 204); a non-2xx answer throws a ScimError with its detail. */
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/scim+json, application/json',
          'user-agent': 'Landbright-SCIM/1',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
    } catch (error) {
      const why = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : '';
      throw new ScimError(null, `${method} ${path}: ${why || 'no answer'}`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { detail: text.slice(0, 300) };
      }
    }
    if (!res.ok) {
      const p = (parsed ?? {}) as { detail?: unknown; scimType?: unknown };
      const detail = typeof p.detail === 'string' ? p.detail : res.statusText || 'no detail';
      throw new ScimError(
        res.status,
        `${method} ${path}: ${res.status} ${detail}`.slice(0, 500),
        retryAfter(res.headers.get('retry-after')),
        typeof p.scimType === 'string' ? p.scimType : undefined,
      );
    }
    return { status: res.status, body: parsed as T };
  }

  create(kind: 'Users' | 'Groups', resource: Record<string, unknown>): Promise<ScimResource> {
    return this.call<ScimResource>('POST', `/${kind}`, resource).then((r) => this.withId(r.body, `POST /${kind}`));
  }

  /** The resource, or null when the server says it's gone. */
  async get(kind: 'Users' | 'Groups', id: string): Promise<ScimResource | null> {
    try {
      return this.withId((await this.call<ScimResource>('GET', `/${kind}/${encodeURIComponent(id)}`)).body, 'GET');
    } catch (error) {
      if (error instanceof ScimError && error.status === 404) return null;
      throw error;
    }
  }

  /** The first resource where `attribute eq value`; null when there is none or the server can't filter on it (400). */
  async findOne(kind: 'Users' | 'Groups', attribute: string, value: string): Promise<ScimResource | null> {
    try {
      const query = new URLSearchParams({ filter: eqFilter(attribute, value) });
      const { body } = await this.call<{ Resources?: ScimResource[] }>('GET', `/${kind}?${query}`);
      const found = body?.Resources?.find((r) => typeof r?.id === 'string');
      return found ?? null;
    } catch (error) {
      if (error instanceof ScimError && error.status === 400) return null;
      throw error;
    }
  }

  /** PATCH; false when the resource is gone (404). */
  async patch(kind: 'Users' | 'Groups', id: string, operations: PatchOp[]): Promise<boolean> {
    if (operations.length === 0) return true;
    try {
      await this.call('PATCH', `/${kind}/${encodeURIComponent(id)}`, {
        schemas: [PATCH_SCHEMA],
        Operations: operations,
      });
      return true;
    } catch (error) {
      if (error instanceof ScimError && error.status === 404) return false;
      throw error;
    }
  }

  async remove(kind: 'Users' | 'Groups', id: string): Promise<void> {
    try {
      await this.call('DELETE', `/${kind}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof ScimError && error.status === 404) return;
      throw error;
    }
  }

  private withId(body: ScimResource | null, what: string): ScimResource {
    if (!body || typeof body.id !== 'string' || !body.id) throw new ScimError(502, `${what}: the answer had no id`);
    return body;
  }
}
