import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type Config, loadConfig, PROBE_TIMEOUT_MS } from '@landbright/platform';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

export const CONFIG = Symbol('CONFIG');
export const PG_POOL = Symbol('PG_POOL');
export const VALKEY = Symbol('VALKEY');

/**
 * Connections to the infrastructure in deploy/compose.infra.yml, one of each per process. Both tolerate the
 * dependency being down at boot and reconnect on their own; the health report says when they are down.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): Config => loadConfig() },
    {
      provide: PG_POOL,
      inject: [CONFIG],
      useFactory: (config: Config): Pool => {
        const pool = new Pool({
          connectionString: config.LANDBRIGHT_DATABASE_URL,
          max: 4,
          connectionTimeoutMillis: PROBE_TIMEOUT_MS,
          application_name: 'landbright-control',
        });
        // An idle client's error (Postgres restarted) must not crash the process; the next query reconnects.
        pool.on('error', (error) => new Logger('postgres').warn(error.message));
        return pool;
      },
    },
    {
      provide: VALKEY,
      inject: [CONFIG],
      useFactory: (config: Config): Redis => {
        const client = new Redis(config.LANDBRIGHT_VALKEY_URL, {
          connectionName: 'landbright-control',
          connectTimeout: PROBE_TIMEOUT_MS,
          // Fail fast while disconnected instead of queueing: the health probe reports the state.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => Math.min(attempt * 250, 5000),
        });
        let warned = false;
        client.on('error', (error) => {
          if (!warned) new Logger('valkey').warn(error.message);
          warned = true;
        });
        client.on('ready', () => (warned = false));
        return client;
      },
    },
  ],
  exports: [CONFIG, PG_POOL, VALKEY],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.valkey.disconnect();
    await this.pool.end();
  }
}
