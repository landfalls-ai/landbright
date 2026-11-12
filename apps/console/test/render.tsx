import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type { HealthReport } from '@landbright/contracts';
import { routes } from '../src/router';

/** Renders the whole console at `path`, with fetch answering `/api/health` from `health` (or failing). */
export function renderAt(path: string, health: HealthReport | 'unreachable') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (health === 'unreachable') throw new TypeError('fetch failed');
      if (url === '/api/health')
        return new Response(JSON.stringify(health), { headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404 });
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
