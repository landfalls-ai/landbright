import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { MACHINE_API_RESOURCE } from '@landbright/platform';
import { PRISMA, type PrismaClient, TENANT, type TenantRef, withTenant } from '@landbright/persistence';
import type { NextFunction, Request, Response } from 'express';
import { KeyRing } from '../common/key-ring';
import type { WithPrincipal } from '../common/principal';

/**
 * Turns `Authorization: Bearer <access token>` on /api/v1 into a service principal: a JWT from Landbright's own issuer
 * (client credentials with the machine API as the resource), whose scopes are what its application was granted. The
 * application must still exist and still hold each scope, so removing a scope takes effect at once rather than when
 * the token expires. Anything else leaves the request without a principal, and the default-deny guard answers 401.
 */
@Injectable()
export class ServiceTokenMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ServiceTokenMiddleware.name);

  constructor(
    private readonly keys: KeyRing,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
  ) {}

  async use(req: Request & WithPrincipal, _res: Response, next: NextFunction): Promise<void> {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!match?.[1]) return next();
    try {
      const claims = await this.keys.verify(match[1], MACHINE_API_RESOURCE);
      const clientId = String(claims.client_id ?? claims.sub ?? '');
      const client = await withTenant(this.prisma, this.tenant.id, (tx) =>
        tx.oidcClient.findUnique({ where: { clientId } }),
      );
      if (!client) return next();
      const granted = String(claims.scope ?? '')
        .split(' ')
        .filter((s) => client.apiScopes.includes(s));
      req.principal = { kind: 'service', clientId, name: client.name, scopes: granted };
    } catch (error) {
      this.logger.debug(`refused a service token: ${error instanceof Error ? error.message : String(error)}`);
    }
    next();
  }
}
