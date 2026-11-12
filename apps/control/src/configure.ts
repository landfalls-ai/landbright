import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { type Config, serviceVersion } from '@landbright/platform';
import { CONFIG } from '@landbright/persistence';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { SessionMiddleware } from './auth/session.middleware';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routes under /api (liveness stays at /healthz), the console session, and the OpenAPI 3.1 document at
 * /api/openapi.json.
 */
export function configureControl(app: INestApplication): void {
  const config = app.get<Config>(CONFIG);
  const consoleOrigin = new URL(config.LANDBRIGHT_CONSOLE_URL).origin;
  app.use(cookieParser());
  // Cross-site request forgery: the session cookie is SameSite=Lax, but other local apps on 127.0.0.1 are the same
  // site. A browser always sends Origin on a write, so a write from any page but the console's is refused.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!SAFE.has(req.method) && origin && origin !== consoleOrigin)
      return next(new ForbiddenException('Cross-origin writes are refused.'));
    next();
  });
  const sessions = app.get(SessionMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => void sessions.use(req, res, next));
  app.setGlobalPrefix('api', { exclude: ['healthz'] });
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Landbright control API')
      .setDescription('The console API: sign-in, directory, applications, audit. docs/reference/api.md describes it.')
      .setVersion(serviceVersion())
      .setOpenAPIVersion('3.1.0')
      .addCookieAuth('lb_session')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(document), { jsonDocumentUrl: 'api/openapi.json' });
}
