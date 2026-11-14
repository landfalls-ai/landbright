import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type { HealthReport, Me } from '@landbright/contracts';
import { routes } from '../src/router';

export const ADMIN: Me = {
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'Ada Admin',
  email: 'admin@landbright.test',
  admin: true,
  tenant: { slug: 'local', name: 'Local' },
};

export interface FakeApi {
  /** Who is signed in: a Me, or 401. */
  me?: Me | 401;
  /** Extra answers by `METHOD path` or `path` (GET); a function gets the request body. */
  routes?: Record<string, unknown | ((body: unknown) => unknown)>;
}

/** Every request the console made, as `METHOD path` with its JSON body. */
export const calls: Array<{ key: string; body: unknown }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Renders the whole console at `path`, with fetch answering the control API from `health` and `api`. */
export function renderAt(path: string, health: HealthReport | 'unreachable', api: FakeApi = {}) {
  calls.length = 0;
  const me = api.me ?? ADMIN;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (health === 'unreachable') throw new TypeError('fetch failed');
      const method = init.method ?? 'GET';
      const pathname = url.split('?')[0]!;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key: `${method} ${pathname}`, body });
      if (pathname === '/api/auth/me')
        return me === 401 ? json({ statusCode: 401, message: 'Unauthorized' }, 401) : json(me);
      if (pathname === '/api/health') return json(health);
      const answer = api.routes?.[`${method} ${pathname}`] ?? (method === 'GET' ? api.routes?.[pathname] : undefined);
      if (answer !== undefined) {
        const value = typeof answer === 'function' ? (answer as (b: unknown) => unknown)(body) : answer;
        return value instanceof Response
          ? value
          : json(
              value,
              method === 'POST' && !pathname.match(/\/(deactivate|reactivate|invite|suspend|resume|rotate-secret)$/)
                ? 201
                : 200,
            );
      }
      if (method === 'GET' && ['/api/people', '/api/agents', '/api/groups'].includes(pathname))
        return json({ items: [] });
      if (method === 'GET' && pathname === '/api/applications')
        return json({ items: [], issuer: 'http://127.0.0.1:4402/oidc' });
      return json({ statusCode: 404, message: 'Not found' }, 404);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

export function report(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    service: 'landbright-control',
    version: '0.1.0',
    environment: 'local',
    status: 'ok',
    checkedAt: new Date().toISOString(),
    components: [
      {
        id: 'idp',
        name: 'Identity plane',
        kind: 'service',
        status: 'up',
        latencyMs: 3.1,
        target: '127.0.0.1:4402',
        detail: 'landbright-idp 0.1.0',
      },
      {
        id: 'postgres',
        name: 'Postgres',
        kind: 'database',
        status: 'up',
        latencyMs: 1.2,
        target: '127.0.0.1:57432',
        detail: 'PostgreSQL 16.10',
      },
    ],
    ...overrides,
  };
}
