import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  appendAudit,
  decoyHash,
  PRISMA,
  type PrismaClient,
  TENANT,
  type TenantRef,
  verifyPassword,
  withTenant,
} from '@landbright/persistence';
import type { Redis } from 'ioredis';
import { VALKEY } from '../valkey';

/** After this many wrong passwords for one email, sign-in for it pauses for the window. */
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_SECONDS = 15 * 60;

export type LoginResult = { ok: true; identityId: string } | { ok: false; reason: 'invalid' | 'locked' };

@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  /**
   * Checks an email and password. An unknown email, a person without a password and a wrong password all take the
   * same time and give the same answer. Failures are counted per email in Valkey; if Valkey is down, counting is
   * skipped (sign-in keeps working) and a warning is logged.
   */
  async verify(rawEmail: string, password: string, from: string): Promise<LoginResult> {
    const email = rawEmail.trim().toLowerCase();
    const key = `lb:login:failures:${this.tenant.id}:${email}`;
    if ((await this.failures(key)) >= MAX_FAILURES) return { ok: false, reason: 'locked' };

    const identity = await withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.identity.findFirst({
        where: { email, kind: 'person', status: 'active' },
        include: { credentials: { where: { kind: 'password' }, orderBy: { createdAt: 'desc' }, take: 1 } },
      }),
    );
    const hash = identity?.credentials[0]?.secret;
    const valid = await verifyPassword(hash ?? (await decoyHash()), password);
    if (!identity || !hash || !valid) {
      await this.countFailure(key);
      if (identity) {
        await withTenant(this.prisma, this.tenant.id, (tx) =>
          appendAudit(tx, this.tenant.id, {
            actorId: identity.id,
            actorLabel: identity.displayName,
            action: 'session.sign_in_failed',
            targetType: 'identity',
            targetId: identity.id,
            data: { from },
          }),
        );
      }
      return { ok: false, reason: 'invalid' };
    }
    await this.valkey.del(key).catch(() => undefined);
    await withTenant(this.prisma, this.tenant.id, async (tx) => {
      await tx.credential.update({ where: { id: identity.credentials[0]!.id }, data: { lastUsedAt: new Date() } });
      await appendAudit(tx, this.tenant.id, {
        actorId: identity.id,
        actorLabel: identity.displayName,
        action: 'session.signed_in',
        targetType: 'identity',
        targetId: identity.id,
        data: { method: 'password', from },
      });
    });
    return { ok: true, identityId: identity.id };
  }

  private async failures(key: string): Promise<number> {
    try {
      return Number((await this.valkey.get(key)) ?? 0);
    } catch {
      this.logger.warn('Valkey unavailable: sign-in failures are not being counted');
      return 0;
    }
  }

  private async countFailure(key: string): Promise<void> {
    try {
      await this.valkey.multi().incr(key).expire(key, FAILURE_WINDOW_SECONDS).exec();
    } catch {
      // Logged by failures().
    }
  }
}
