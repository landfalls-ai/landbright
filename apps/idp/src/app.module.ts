import { Module } from '@nestjs/common';
import { type Config, createValkey, livenessController } from '@landbright/platform';
import { CONFIG, PersistenceModule, PRISMA, type PrismaClient, TENANT, type TenantRef } from '@landbright/persistence';
import { InteractionController } from './interactions/interaction.controller';
import { LoginService } from './interactions/login.service';
import { PasskeyService } from './interactions/passkey.service';
import { SecondStepService } from './interactions/second-step.service';
import { InviteController } from './invite/invite.controller';
import { OidcProviderRef } from './oidc/provider-ref';
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
    PasskeyService,
    SecondStepService,
    {
      provide: VALKEY,
      inject: [CONFIG],
      useFactory: (config: Config) => createValkey(config.LANDBRIGHT_VALKEY_URL, 'landbright-idp'),
    },
    {
      provide: OIDC_PROVIDER,
      inject: [CONFIG, PRISMA, TENANT],
      useFactory: (config: Config, prisma: PrismaClient, tenant: TenantRef) =>
        OidcProviderRef.create(config, prisma, tenant),
    },
  ],
})
export class AppModule {}
