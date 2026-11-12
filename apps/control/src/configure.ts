import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { serviceVersion } from '@landbright/platform';
import { cleanupOpenApiDoc } from 'nestjs-zod';

/** Routes under /api (liveness stays at /healthz), and the OpenAPI 3.1 document at /api/openapi.json. */
export function configureControl(app: INestApplication): void {
  app.setGlobalPrefix('api', { exclude: ['healthz'] });
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Landbright control API')
      .setDescription('The console API: directory, catalog, requests, grants. docs/reference/api.md describes it.')
      .setVersion(serviceVersion())
      .setOpenAPIVersion('3.1.0')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(document), { jsonDocumentUrl: 'api/openapi.json' });
}
