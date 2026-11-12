import { Module } from '@nestjs/common';
import { livenessController } from '@landbright/platform';

/**
 * The identity plane. Wave 0 serves liveness only; wave 1 mounts the OIDC provider (`oidc-provider`), the sign-in
 * pages and JWKS here (plan §7).
 */
@Module({
  controllers: [livenessController('landbright-idp')],
})
export class AppModule {}
