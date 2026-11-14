import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type Config, loadConfig } from '@landbright/platform';
import type { PrismaClient } from '@prisma/client';
import { createPrisma } from './prisma';
import { resolveTenant, type TenantRef } from './tenant';

export const CONFIG = Symbol('CONFIG');
export const PRISMA = Symbol('PRISMA');
export const TENANT = Symbol('TENANT');

/**
 * The database for a service: one Prisma client as landbright_app, and the tenant this deployment serves (resolved
 * at boot; a service refuses to start without one, which `pnpm db:setup` creates).
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): Config => loadConfig() },
    { provide: PRISMA, inject: [CONFIG], useFactory: (config: Config) => createPrisma(config.LANDBRIGHT_DATABASE_URL) },
    {
      provide: TENANT,
      inject: [PRISMA, CONFIG],
      useFactory: (prisma: PrismaClient, config: Config): Promise<TenantRef> =>
        resolveTenant(prisma, config.LANDBRIGHT_TENANT_SLUG),
    },
  ],
  exports: [CONFIG, PRISMA, TENANT],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
