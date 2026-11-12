import type { ComponentHealth, ComponentKind } from '@landbright/contracts';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

/** How long one probe may take before it counts as down. The health page polls every 5 s, so stay well under. */
export const PROBE_TIMEOUT_MS = 2000;

interface ProbeTarget {
  id: string;
  name: string;
  kind: ComponentKind;
  /** `host:port`, already stripped of credentials. */
  target: string;
}

/** Runs `check` under the timeout and turns its outcome into a component row. `check` returns the detail to show. */
export async function probe(
  what: ProbeTarget,
  check: (signal: AbortSignal) => Promise<string | undefined>,
): Promise<ComponentHealth> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer in ${PROBE_TIMEOUT_MS} ms`));
    }, PROBE_TIMEOUT_MS);
  });
  try {
    const detail = await Promise.race([check(controller.signal), timeout]);
    return { ...what, status: 'up', latencyMs: elapsed(started), ...(detail ? { detail } : {}) };
  } catch (error) {
    return { ...what, status: 'down', latencyMs: elapsed(started), detail: reason(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Postgres: a round trip on the pool, reporting the server version. */
export function probePostgres(pool: Pool, target: string): Promise<ComponentHealth> {
  return probe({ id: 'postgres', name: 'Postgres', kind: 'database', target }, async () => {
    const result = await pool.query<{ server_version: string }>('SHOW server_version');
    return `PostgreSQL ${result.rows[0]?.server_version.split(' ')[0] ?? ''}`.trim();
  });
}

/** Valkey: PING, then the server version from INFO. */
export function probeValkey(client: Redis, target: string): Promise<ComponentHealth> {
  return probe({ id: 'valkey', name: 'Valkey', kind: 'cache', target }, async () => {
    if (client.status !== 'ready') throw new Error(`not connected (${client.status})`);
    const pong = await client.ping();
    if (pong !== 'PONG') throw new Error(`unexpected reply ${pong}`);
    const info = await client.info('server');
    const version = /valkey_version:(\S+)/.exec(info)?.[1] ?? /redis_version:(\S+)/.exec(info)?.[1];
    return version ? `Valkey ${version}` : undefined;
  });
}

/**
 * An HTTP dependency: 2xx is up. `describe` turns the JSON body into the detail (a version), and may throw to mark an
 * answer that is 2xx but wrong (a sealed OpenBao).
 */
export function probeHttp(
  what: ProbeTarget,
  url: string,
  describe: (body: unknown) => string | undefined = () => undefined,
  headers: Record<string, string> = {},
): Promise<ComponentHealth> {
  return probe(what, async (signal) => {
    const response = await fetch(url, { signal, headers: { accept: 'application/json', ...headers } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = response.headers.get('content-type')?.includes('json') ? await response.json() : undefined;
    return describe(body);
  });
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}

function reason(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) return reason(error.errors[0]);
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') return 'connection refused';
    const cause = (error as { cause?: unknown }).cause;
    if (error.message === 'fetch failed' && cause) return reason(cause);
    return error.message;
  }
  return String(error);
}
