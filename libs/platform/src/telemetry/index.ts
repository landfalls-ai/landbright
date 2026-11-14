import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

/**
 * Starts OpenTelemetry for a service, after Landflow's observability contract: one service per process
 * (`landbright-idp`, `landbright-control`), W3C trace context on every HTTP call, `landbright.*` span attributes.
 *
 * Traces, metrics (HTTP server and client durations, Node runtime: event loop, heap, GC) and logs (every Nest
 * `Logger` line, through TelemetryLogger in log-bridge.ts, with its trace and span ids). Clickland, the land family's
 * observability system, receives them on its collector (OTLP over HTTP, http://127.0.0.1:24318 locally).
 *
 * Import this before anything else in `main.ts` so the instrumentations patch `http`, `express`, `pg` and `ioredis`
 * before they load. Everything stays off unless an exporter is configured: `OTEL_EXPORTER_OTLP_ENDPOINT` turns on all
 * three signals (each can be switched off with `OTEL_<SIGNAL>_EXPORTER=none`); without an endpoint, only the signals
 * an `OTEL_<SIGNAL>_EXPORTER` names start (`console` prints them). Returns whether it started.
 */
export function startTelemetry(serviceName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (sdk) return true;
  const endpoint = Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!endpoint && !env.OTEL_TRACES_EXPORTER && !env.OTEL_METRICS_EXPORTER && !env.OTEL_LOGS_EXPORTER) return false;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? serviceName,
      [ATTR_SERVICE_VERSION]: env.npm_package_version ?? '0.0.0',
      'deployment.environment.name': env.LANDBRIGHT_ENV ?? 'local',
    }),
    // The SDK defaults each signal to OTLP; without an endpoint, a signal nobody named stays off (an empty list).
    ...(!endpoint && !env.OTEL_METRICS_EXPORTER && { metricReaders: [] }),
    ...(!endpoint && !env.OTEL_LOGS_EXPORTER && { logRecordProcessors: [] }),
    ...(!endpoint && !env.OTEL_TRACES_EXPORTER && { spanProcessors: [] }),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => request.url === '/healthz' }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
      new RuntimeNodeInstrumentation(),
    ],
  });
  sdk.start();
  const stop = () => void sdk?.shutdown().catch(() => undefined);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return true;
}
