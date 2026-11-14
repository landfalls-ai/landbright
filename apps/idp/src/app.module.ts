import { Module } from '@nestjs/common';
import { type Config, createValkey, livenessController } from '@landbright/platform';
import { CONFIG, PersistenceModule, PRISMA, type PrismaClient, TENANT, type TenantRef } from '@landbright/persistence';
import { AccountController } from './account/account.controller';
import { AccountService } from './account/account.service';
import { SelfSession } from './account/self-session';
import { CibaController } from './ciba/ciba.controller';
import { ResetController } from './account/reset.controller';
import { InteractionController } from './interactions/interaction.controller';
import { Mailer } from './mail/mailer';
import { LoginService } from './interactions/login.service';
import { PasskeyService } from './interactions/passkey.service';
import { SecondStepService } from './interactions/second-step.service';
import { InviteController } from './invite/invite.controller';
import { OidcProviderRef } from './oidc/provider-ref';
import { AssetsController } from './pages/assets.controller';
import { OIDC_PROVIDER, VALKEY } from './valkey';

/**
 * The identity plane: the OIDC provider (mounted at /oidc in main.ts), the sign-in, invite, password-reset and account
 * pages, and the stylesheet they share.
 */
@Module({
  imports: [PersistenceModule],
  controllers: [
    CibaController,
    livenessController('landbright-idp'),
    AssetsController,
    InteractionController,
    InviteController,
    ResetController,
    AccountController,
  ],
  providers: [
    AccountService,
    SelfSession,
    Mailer,
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
