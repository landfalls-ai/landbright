import { type INestApplication, Logger, type Type } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import helmet from 'helmet';
import { DefaultDenyGuard } from './auth/default-deny.guard';

export interface ServiceOptions {
  /** `landbright-idp`, `landbright-control`: the logger context and the OpenTelemetry service name. */
  name: string;
  port: number;
  /** Runs after the app is created and before it listens (OpenAPI, prefixes). */
  configure?: (app: INestApplication) => void | Promise<void>;
}

/**
 * Creates a Landbright service the same way every time: security headers, the default-deny guard, graceful shutdown,
 * and a listener on 127.0.0.1 only (constitution principle IX: local only).
 */
export async function startService(module: Type<unknown>, options: ServiceOptions): Promise<INestApplication> {
  const app = await NestFactory.create(module, { bufferLogs: false });
  app.use(helmet());
  app.useGlobalGuards(new DefaultDenyGuard(app.get(Reflector)));
  app.enableShutdownHooks();
  await options.configure?.(app);
  await app.listen(options.port, '127.0.0.1');
  new Logger(options.name).log(`listening on http://127.0.0.1:${options.port}`);
  return app;
}
