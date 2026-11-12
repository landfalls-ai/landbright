import { type INestApplication, Logger, type Type } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import helmet, { type HelmetOptions } from 'helmet';
import { DefaultDenyGuard } from './auth/default-deny.guard';

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
 * and a listener on 127.0.0.1 only (constitution principle IX: local only).
 */
export async function startService(module: Type<unknown>, options: ServiceOptions): Promise<INestApplication> {
  const app = await NestFactory.create(module, { bodyParser: options.bodyParser ?? true });
  applyServiceDefaults(app, options);
  await options.configure?.(app);
  await app.listen(options.port, '127.0.0.1');
  new Logger(options.name).log(`listening on http://127.0.0.1:${options.port}`);
  return app;
}

/** The part of startService that tests reuse on a testing module's app. */
export function applyServiceDefaults(app: INestApplication, options: Pick<ServiceOptions, 'helmet'> = {}): void {
  app.use(helmet(options.helmet));
  app.useGlobalGuards(new DefaultDenyGuard(app.get(Reflector)));
  app.enableShutdownHooks();
}
