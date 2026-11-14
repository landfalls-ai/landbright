import { createServer, type RequestListener, type Server } from 'node:http';
import { type INestApplication, Logger, type Type } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import helmet, { type HelmetOptions } from 'helmet';
import { DefaultDenyGuard } from './auth/default-deny.guard';
import { TelemetryLogger } from './log-bridge';

export interface ServiceOptions {
  /** `landbright-idp`, `landbright-control`: the logger context and the OpenTelemetry service name. */
  name: string;
  port: number;
  /** Helmet's options; the default is Helmet's defaults. */
  helmet?: HelmetOptions;
  /** Nest's JSON and urlencoded body parsers. Off for the identity plane, where oidc-provider parses its own. */
  bodyParser?: boolean;
  /** Runs after the app is created and before it listens (OpenAPI, prefixes, extra middleware). */
  configure?: (app: INestApplication) => void | Promise<void>;
}

/**
 * Creates a Landbright service the same way every time: security headers, the default-deny guard, graceful shutdown,
 * and listeners on the loopback addresses only (constitution principle IX: local only): 127.0.0.1, and ::1 as well,
 * since the issuer is `http://localhost:…` and some clients (Landfall's server among them) try `localhost` as ::1
 * first.
 */
export async function startService(module: Type<unknown>, options: ServiceOptions): Promise<INestApplication> {
  // forceCloseConnections: a browser's keep-alive connection would otherwise hold shutdown (and the watcher's restart)
  // open until the browser lets go.
  // The logger also sends each line to OpenTelemetry (log-bridge.ts) when telemetry is exporting.
  const app = await NestFactory.create(module, {
    bodyParser: options.bodyParser ?? true,
    forceCloseConnections: true,
    logger: new TelemetryLogger(options.name),
  });
  applyServiceDefaults(app, options);
  await options.configure?.(app);
  await app.listen(options.port, '127.0.0.1');
  const log = new Logger(options.name);
  log.log(`listening on http://127.0.0.1:${options.port}`);
  await listenOnIpv6Loopback(app, options.port, log);
  return app;
}

/** The part of startService that tests reuse on a testing module's app. */
export function applyServiceDefaults(app: INestApplication, options: Pick<ServiceOptions, 'helmet'> = {}): void {
  app.use(helmet(options.helmet));
  app.useGlobalGuards(new DefaultDenyGuard(app.get(Reflector)));
  app.enableShutdownHooks();
}

/** The same app on [::1]: a second server with the same handler, closed with the first. Skipped where there's no IPv6. */
async function listenOnIpv6Loopback(app: INestApplication, port: number, log: Logger): Promise<void> {
  const primary = app.getHttpServer() as Server;
  const handler = app.getHttpAdapter().getInstance() as RequestListener;
  const v6 = createServer(handler);
  v6.keepAliveTimeout = primary.keepAliveTimeout;
  await new Promise<void>((done) => {
    v6.once('error', (err: NodeJS.ErrnoException) => {
      log.warn(`not listening on [::1]:${port} (${err.code ?? err.message})`);
      done();
    });
    v6.listen({ port, host: '::1', ipv6Only: true }, () => {
      log.log(`listening on http://[::1]:${port}`);
      primary.once('close', () => {
        v6.closeAllConnections();
        v6.close();
      });
      done();
    });
  });
}
