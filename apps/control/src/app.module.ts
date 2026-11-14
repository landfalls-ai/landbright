import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { livenessController } from '@landbright/platform';
import { PersistenceModule } from '@landbright/persistence';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { AccessController, BundlesController } from './access/access.controller';
import { AccessService } from './access/access.service';
import { AccessSweeper } from './access/access.sweeper';
import { ApplicationsController } from './applications/applications.controller';
import { ApplicationsService } from './applications/applications.service';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { ConsoleOidc } from './auth/console-oidc';
import { SessionMiddleware } from './auth/session.middleware';
import { SessionStore } from './auth/session.store';
import { InfraModule } from './common/infra.module';
import { KeyRing } from './common/key-ring';
import { TenantDb } from './common/tenant-db';
import { AgentsController } from './directory/agents.controller';
import { AgentsService } from './directory/agents.service';
import { GroupsController } from './directory/groups.controller';
import { GroupsService } from './directory/groups.service';
import { PeopleController } from './directory/people.controller';
import { PeopleService } from './directory/people.service';
import { EventWorker } from './events/event-worker';
import { EventsController } from './events/events.controller';
import { EventsService } from './events/events.service';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { Mailer } from './mail/mailer';
import { MachineController } from './machine/machine.controller';
import { ProvisioningController } from './provisioning/provisioning.controller';
import { ProvisioningService } from './provisioning/provisioning.service';
import { ScimSync } from './provisioning/scim-sync';
import { LogoutSender } from './logout/logout-sender';
import { ServiceTokenMiddleware } from './machine/service-token.middleware';
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
    BundlesController,
    AccessController,
    EventsController,
    ProvisioningController,
    MachineController,
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
    KeyRing,
    ServiceTokenMiddleware,
    AccessService,
    AccessSweeper,
    EventsService,
    EventWorker,
    ProvisioningService,
    ScimSync,
    LogoutSender,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
