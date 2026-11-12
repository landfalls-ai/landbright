import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { livenessController } from '@landbright/platform';
import { PersistenceModule } from '@landbright/persistence';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { ApplicationsController } from './applications/applications.controller';
import { ApplicationsService } from './applications/applications.service';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { ConsoleOidc } from './auth/console-oidc';
import { SessionMiddleware } from './auth/session.middleware';
import { SessionStore } from './auth/session.store';
import { InfraModule } from './common/infra.module';
import { TenantDb } from './common/tenant-db';
import { AgentsController } from './directory/agents.controller';
import { AgentsService } from './directory/agents.service';
import { GroupsController } from './directory/groups.controller';
import { GroupsService } from './directory/groups.service';
import { PeopleController } from './directory/people.controller';
import { PeopleService } from './directory/people.service';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { Mailer } from './mail/mailer';
import { SettingsController } from './settings/settings.controller';

/**
 * The control plane. Every request body is validated and every response serialized against its zod contract
 * (`libs/contracts`), which is also what the OpenAPI document at /api/openapi.json is generated from.
 */
@Module({
  imports: [PersistenceModule, InfraModule],
  controllers: [
    livenessController('landbright-control'),
    HealthController,
    AuthController,
    PeopleController,
    AgentsController,
    GroupsController,
    ApplicationsController,
    AuditController,
    SettingsController,
  ],
  providers: [
    HealthService,
    TenantDb,
    SessionStore,
    SessionMiddleware,
    ConsoleOidc,
    Mailer,
    PeopleService,
    AgentsService,
    GroupsService,
    ApplicationsService,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
