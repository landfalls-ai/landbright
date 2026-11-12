import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { livenessController } from '@landbright/platform';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { InfraModule } from './infra/infra.module';

/**
 * The control plane. Every request body is validated and every response serialized against its zod contract
 * (`libs/contracts`), which is also what the OpenAPI document at /api/openapi.json is generated from.
 */
@Module({
  imports: [InfraModule],
  controllers: [livenessController('landbright-control'), HealthController],
  providers: [
    HealthService,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
