import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PROBE_TIMEOUT_MS } from './health/probes';

/**
 * A Valkey client for a service. Fails fast while disconnected (no offline queue), so callers and the health probe see
 * the outage at once; reconnects on its own; logs the first error of each outage only.
 */
export function createValkey(url: string, name: string): Redis {
  const client = new Redis(url, {
    connectionName: name,
    connectTimeout: PROBE_TIMEOUT_MS,
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
}
