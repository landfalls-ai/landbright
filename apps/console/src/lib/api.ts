import { HealthReport } from '@landbright/contracts';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET a control API route (proxied from /api) and check the body against its contract. */
export async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'The control API did not answer.');
  }
  // Vite's proxy answers 502/504 (or 500 with an empty body) when control isn't running.
  if (!response.ok) throw new ApiError(response.status, `The control API answered ${response.status}.`);
  return schema.parse(await response.json());
}

/** The health report, refreshed every 5 seconds. */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => getJson('/api/health', HealthReport),
    refetchInterval: 5000,
    retry: false,
  });
}
