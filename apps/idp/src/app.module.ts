import { Module } from '@nestjs/common';
import { type Config, createValkey, livenessController } from '@landbright/platform';
import { CONFIG, PersistenceModule, PRISMA, type PrismaClient, TENANT, type TenantRef } from '@landbright/persistence';
import { InteractionController } from './interactions/interaction.controller';
import { LoginService } from './interactions/login.service';
import { InviteController } from './invite/invite.controller';
import { loadSigningKeys } from './oidc/keys';
import { createProvider } from './oidc/provider';
import { AssetsController } from './pages/assets.controller';
import { OIDC_PROVIDER, VALKEY } from './valkey';

/**
 * The identity plane: the OIDC provider (mounted at /oidc in main.ts), the sign-in and invite pages, and the
 * stylesheet they share.
 */
@Module({
  imports: [PersistenceModule],
  controllers: [livenessController('landbright-idp'), AssetsController, InteractionController, InviteController],
  providers: [
    LoginService,
    {
      provide: VALKEY,
      inject: [CONFIG],
      useFactory: (config: Config) => createValkey(config.LANDBRIGHT_VALKEY_URL, 'landbright-idp'),
    },
    {
      provide: OIDC_PROVIDER,
      inject: [CONFIG, PRISMA, TENANT],
      useFactory: async (config: Config, prisma: PrismaClient, tenant: TenantRef) =>
        createProvider(config, prisma, tenant, await loadSigningKeys(prisma, config.LANDBRIGHT_SECRET_KEY)),
    },
  ],
})
export class AppModule {}
