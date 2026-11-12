import { z } from 'zod';

/**
 * Health: what `GET /api/health` (control) returns, and what `GET /healthz` (idp, control) answers for liveness.
 * docs/reference/api.md describes both.
 */

export const ComponentKind = z.enum(['service', 'database', 'cache', 'secrets', 'mail']);
export type ComponentKind = z.infer<typeof ComponentKind>;

export const ComponentStatus = z.enum(['up', 'down']);
export type ComponentStatus = z.infer<typeof ComponentStatus>;

/** One dependency as control saw it a moment ago. */
export const ComponentHealth = z.object({
  /** Stable id: `idp`, `postgres`, `valkey`, `openbao`, `mailpit`. */
  id: z.string(),
  name: z.string(),
  kind: ComponentKind,
  status: ComponentStatus,
  /** How long the probe took, in milliseconds (up to the probe's timeout when it failed). */
  latencyMs: z.number().nonnegative(),
  /** Where it was reached, `host:port`, never with credentials. */
  target: z.string(),
  /** The version it reported when up; the reason when down. */
  detail: z.string().optional(),
});
export type ComponentHealth = z.infer<typeof ComponentHealth>;

export const OverallStatus = z.enum(['ok', 'degraded', 'down']);
export type OverallStatus = z.infer<typeof OverallStatus>;

export const HealthReport = z.object({
  service: z.literal('landbright-control'),
  version: z.string(),
  /** `local` for development; shown as the environment badge in the console. */
  environment: z.string(),
  status: OverallStatus,
  checkedAt: z.iso.datetime(),
  components: z.array(ComponentHealth),
});
export type HealthReport = z.infer<typeof HealthReport>;

/** Liveness: the process is up and serving. Says nothing about its dependencies. */
export const Liveness = z.object({
  status: z.literal('ok'),
  service: z.enum(['landbright-idp', 'landbright-control']),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});
export type Liveness = z.infer<typeof Liveness>;

/** `ok` when every component is up, `down` when none is, `degraded` in between (and for an empty list: nothing known). */
export function overallStatus(components: readonly Pick<ComponentHealth, 'status'>[]): OverallStatus {
  const up = components.filter((c) => c.status === 'up').length;
  if (components.length > 0 && up === components.length) return 'ok';
  if (components.length > 0 && up === 0) return 'down';
  return 'degraded';
}
