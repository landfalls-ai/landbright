import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { MACHINE_API_RESOURCE } from '@landbright/platform';
import { PRISMA, type PrismaClient, TENANT, type TenantRef, withTenant } from '@landbright/persistence';
import type { NextFunction, Request, Response } from 'express';
import { KeyRing } from '../common/key-ring';
import { DpopVerifier } from './dpop';
import type { WithPrincipal } from '../common/principal';

/**
 * Turns `Authorization: Bearer <access token>` (or `DPoP <access token>` with a `DPoP` proof) on /api/v1 into a service
 * principal: a JWT from Landbright's own issuer for the machine API, whose scopes are what its application was granted.
 * The application must still exist and still hold each scope, so removing a scope takes effect at once rather than
 * when the token expires. An agent's application acts as its agent, which must be active; a token with `act` (token
 * exchange) acts for its `sub`, who must be an active person. A DPoP-bound token (`cnf.jkt`) works only with a valid
 * proof. Anything else leaves the request without a principal, and the default-deny guard answers 401.
 */
@Injectable()
export class ServiceTokenMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ServiceTokenMiddleware.name);
  private readonly dpop = new DpopVerifier();

  constructor(
    private readonly keys: KeyRing,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
  ) {}

  async use(req: Request & WithPrincipal, _res: Response, next: NextFunction): Promise<void> {
    const match = /^(Bearer|DPoP)\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!match?.[2]) return next();
    const [, scheme, token] = match as unknown as [string, string, string];
    try {
      const claims = await this.keys.verify(token, MACHINE_API_RESOURCE);
      const jkt = (claims.cnf as { jkt?: string } | undefined)?.jkt;
      if (jkt) {
        if (scheme.toLowerCase() !== 'dpop') throw new Error('a DPoP-bound token must be sent with the DPoP scheme');
        await this.dpop.verify(String(req.headers.dpop ?? ''), {
          method: req.method,
          url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
          accessToken: token,
          jkt,
        });
      } else if (scheme.toLowerCase() !== 'bearer') throw new Error('the DPoP scheme needs a DPoP-bound token');
      const clientId = String(claims.client_id ?? claims.sub ?? '');
      const act = claims.act as { sub?: string } | undefined;
      const found = await withTenant(this.prisma, this.tenant.id, async (tx) => ({
        client: await tx.oidcClient.findUnique({ where: { clientId }, include: { agent: true } }),
        person:
          act && claims.sub && claims.sub !== clientId
            ? await tx.identity.findFirst({ where: { id: String(claims.sub), kind: 'person', status: 'active' } })
            : null,
      }));
      const { client, person } = found;
      if (!client) return next();
      if (
        client.agentId &&
        (client.agent?.status !== 'active' || (act?.sub !== undefined && act.sub !== client.agentId))
      )
        throw new Error('the agent is not active, or the token is not its');
      if (act && !person) throw new Error('the person this token acts for is not active');
      const granted = String(claims.scope ?? '')
        .split(' ')
        .filter((s) => client.apiScopes.includes(s));
      req.principal = {
        kind: 'service',
        clientId,
        name: person ? `${client.name} for ${person.displayName}` : client.name,
        scopes: granted,
        agentId: client.agentId,
        actingFor: person ? { id: person.id, displayName: person.displayName } : null,
      };
    } catch (error) {
      this.logger.debug(`refused a service token: ${error instanceof Error ? error.message : String(error)}`);
    }
    next();
  }
}
