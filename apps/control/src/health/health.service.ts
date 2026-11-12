import { Inject, Injectable } from '@nestjs/common';
import { type HealthReport, Liveness, overallStatus } from '@landbright/contracts';
import { type Config, hostOf, probeHttp, probePostgres, probeValkey, serviceVersion } from '@landbright/platform';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { CONFIG, PG_POOL, VALKEY } from '../infra/infra.module';

/** Probes every dependency in parallel and reports what it saw. Each probe is bounded by `PROBE_TIMEOUT_MS`. */
@Injectable()
export class HealthService {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  async report(): Promise<HealthReport> {
    const c = this.config;
    const components = await Promise.all([
      probeHttp(
        { id: 'idp', name: 'Identity plane', kind: 'service', target: hostOf(c.LANDBRIGHT_IDP_URL) },
        new URL('/healthz', c.LANDBRIGHT_IDP_URL).href,
        (body) => `landbright-idp ${Liveness.parse(body).version}`,
      ),
      probePostgres(this.pool, hostOf(c.LANDBRIGHT_DATABASE_URL)),
      probeValkey(this.valkey, hostOf(c.LANDBRIGHT_VALKEY_URL)),
      probeHttp(
        { id: 'openbao', name: 'OpenBao', kind: 'secrets', target: hostOf(c.LANDBRIGHT_OPENBAO_ADDR) },
        new URL('/v1/sys/health', c.LANDBRIGHT_OPENBAO_ADDR).href,
        (body) => {
          const health = body as { version?: string; sealed?: boolean };
          if (health.sealed) throw new Error('sealed');
          return health.version ? `OpenBao ${health.version}` : undefined;
        },
      ),
      probeHttp(
        { id: 'mailpit', name: 'Mailpit', kind: 'mail', target: hostOf(c.LANDBRIGHT_MAILPIT_URL) },
        new URL('/api/v1/info', c.LANDBRIGHT_MAILPIT_URL).href,
        (body) => {
          const info = body as { Version?: string };
          return info.Version ? `Mailpit ${info.Version}` : undefined;
        },
      ),
    ]);
    return {
      service: 'landbright-control',
      version: serviceVersion(),
      environment: c.LANDBRIGHT_ENV,
      status: overallStatus(components),
      checkedAt: new Date().toISOString(),
      components,
    };
  }
}
