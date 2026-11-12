import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

/**
 * Starts OpenTelemetry tracing for a service, after Landflow's observability contract: one service per process
 * (`landbright-idp`, `landbright-control`), W3C trace context on every HTTP call, `landbright.*` span attributes.
 *
 * Import this before anything else in `main.ts` so the instrumentations patch `http`, `express`, `pg` and `ioredis`
 * before they load. Tracing stays off unless an exporter is configured: `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP over HTTP)
 * or `OTEL_TRACES_EXPORTER` (`console` prints spans to stdout). Returns whether it started.
 */
export function startTelemetry(serviceName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (sdk) return true;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_TRACES_EXPORTER) return false;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? serviceName,
      [ATTR_SERVICE_VERSION]: env.npm_package_version ?? '0.0.0',
      'deployment.environment.name': env.LANDBRIGHT_ENV ?? 'local',
    }),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => request.url === '/healthz' }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  const stop = () => void sdk?.shutdown().catch(() => undefined);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return true;
}
