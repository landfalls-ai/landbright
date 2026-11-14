import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { ADMINS_GROUP, PRISMA, type PrismaClient, TENANT, type TenantRef, withTenant } from '@landbright/persistence';
import type { NextFunction, Request, Response } from 'express';
import type { WithPrincipal } from '../common/principal';
import { SESSION_COOKIE, SessionStore } from './session.store';

/**
 * Turns the console's session cookie into a principal. The person must still be active, and is an administrator only
 * while they are in Landbright Admins: both are checked on every request, so removing someone takes effect at once.
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(
    private readonly sessions: SessionStore,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
  ) {}

  async use(req: Request & WithPrincipal, _res: Response, next: NextFunction): Promise<void> {
    const sessionId = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!sessionId) return next();
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) return next();
      const identity = await withTenant(this.prisma, this.tenant.id, (tx) =>
        tx.identity.findFirst({
          where: { id: session.identityId, status: 'active', kind: 'person' },
          include: { memberships: { where: { group: { name: ADMINS_GROUP } }, select: { groupId: true } } },
        }),
      );
      if (!identity) {
        await this.sessions.destroy(sessionId);
        return next();
      }
      req.principal = {
        kind: 'person',
        id: identity.id,
        displayName: identity.displayName,
        email: identity.email ?? '',
        admin: identity.memberships.length > 0,
        sessionId,
      };
    } catch {
      // Valkey or Postgres down: no principal, so the guard answers 401 and the health page explains why.
    }
    next();
  }
}
