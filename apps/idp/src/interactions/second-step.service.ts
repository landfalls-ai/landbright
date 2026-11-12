import { Inject, Injectable } from '@nestjs/common';
import { type Config, seal, unseal } from '@landbright/platform';
import {
  appendAudit,
  CONFIG,
  PRISMA,
  type PrismaClient,
  TENANT,
  type TenantRef,
  withTenant,
} from '@landbright/persistence';
import type { Redis } from 'ioredis';
import { VALKEY } from '../valkey';
import { PasskeyService } from './passkey.service';
import { checkTotp, newTotpSecret } from './totp';

/** Someone who got their password right and is between the first and second step of one sign-in. */
export interface Pending {
  identityId: string;
  email: string;
  displayName: string;
  /**
   * `verify`: prove it with what's already set up (a code from the app, or a passkey). `enroll`: set one up now (the
   * app's seed is here until confirmed).
   */
  mode: 'verify' | 'enroll';
  /** What they have set up: an authenticator app, a passkey (only when passkeys are on). */
  totp: boolean;
  passkey: boolean;
  secret?: string;
  /** Whether the tenant requires a second step, so enrolling can't be skipped. */
  required: boolean;
}

const PENDING_TTL_SECONDS = 600;
/** Someone who chose "Not now" isn't asked again for this long. */
export const SKIP_DAYS = 30;

@Injectable()
export class SecondStepService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly passkeys: PasskeyService,
  ) {}

  /**
   * What comes after a correct password: a code or a passkey when the person has one set up; setting one up when the
   * tenant requires it; an offer to set one up (once every 30 days) otherwise; or nothing.
   */
  async next(
    uid: string,
    who: { identityId: string; email: string; displayName: string },
  ): Promise<Pending | undefined> {
    const [totp, passkey, tenant] = await Promise.all([
      withTenant(this.prisma, this.tenant.id, (tx) =>
        tx.credential.findFirst({ where: { identityId: who.identityId, kind: 'totp' }, select: { id: true } }),
      ),
      this.passkeys.has(who.identityId),
      this.prisma.tenant.findUnique({ where: { id: this.tenant.id }, select: { mfaRequired: true } }),
    ]);
    const required = Boolean(tenant?.mfaRequired);
    const has = { totp: Boolean(totp), passkey };
    let pending: Pending | undefined;
    if (has.totp || has.passkey) pending = { ...who, ...has, mode: 'verify', required };
    else if (required || !(await this.skipped(who.identityId)))
      pending = { ...who, ...has, mode: 'enroll', secret: newTotpSecret(), required };
    if (pending) await this.valkey.set(this.key(uid), JSON.stringify(pending), 'EX', PENDING_TTL_SECONDS);
    return pending;
  }

  async get(uid: string): Promise<Pending | undefined> {
    const raw = await this.valkey.get(this.key(uid));
    return raw ? (JSON.parse(raw) as Pending) : undefined;
  }

  async clear(uid: string): Promise<void> {
    await this.valkey.del(this.key(uid));
  }

  /** Checks a code from the person's app. A code works once (the step is stored). */
  async verify(pending: Pending, code: string): Promise<boolean> {
    return withTenant(this.prisma, this.tenant.id, async (tx) => {
      const credential = await tx.credential.findFirst({
        where: { identityId: pending.identityId, kind: 'totp' },
        orderBy: { createdAt: 'desc' },
      });
      if (!credential) return false;
      const step = checkTotp(unseal(this.config.LANDBRIGHT_SECRET_KEY, credential.secret), code, credential.counter);
      if (step === undefined) return false;
      // Conditional on the old counter, so two submissions of one code can't both pass.
      const claimed = await tx.credential.updateMany({
        where: { id: credential.id, counter: credential.counter },
        data: { counter: step, lastUsedAt: new Date() },
      });
      return claimed.count === 1;
    });
  }

  /** Confirms a new app with its first code and stores the seed, sealed. */
  async enroll(pending: Pending, code: string): Promise<boolean> {
    const step = pending.secret ? checkTotp(pending.secret, code, 0n) : undefined;
    if (step === undefined) return false;
    const tenantId = this.tenant.id;
    await withTenant(this.prisma, tenantId, async (tx) => {
      await tx.credential.deleteMany({ where: { identityId: pending.identityId, kind: 'totp' } });
      await tx.credential.create({
        data: {
          tenantId,
          identityId: pending.identityId,
          kind: 'totp',
          label: 'Authenticator app',
          secret: seal(this.config.LANDBRIGHT_SECRET_KEY, pending.secret!),
          counter: step,
          lastUsedAt: new Date(),
        },
      });
      await appendAudit(tx, tenantId, {
        actorId: pending.identityId,
        actorLabel: pending.displayName,
        action: 'credential.totp_added',
        targetType: 'identity',
        targetId: pending.identityId,
      });
    });
    return true;
  }

  async skip(identityId: string): Promise<void> {
    await this.valkey
      .set(`lb:mfa:skipped:${this.tenant.id}:${identityId}`, '1', 'EX', SKIP_DAYS * 86_400)
      .catch(() => undefined);
  }

  private async skipped(identityId: string): Promise<boolean> {
    try {
      return (await this.valkey.exists(`lb:mfa:skipped:${this.tenant.id}:${identityId}`)) === 1;
    } catch {
      return true; // Valkey down: don't nag.
    }
  }

  private key(uid: string): string {
    return `lb:mfa:pending:${uid}`;
  }
}
