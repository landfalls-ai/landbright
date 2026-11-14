import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RequiredAction } from '@landbright/contracts';
import { sha256 } from '@landbright/platform';
import {
  appendAudit,
  hashPassword,
  PRISMA,
  type Prisma,
  type PrismaClient,
  TENANT,
  type TenantRef,
  verifyPassword,
  withTenant,
} from '@landbright/persistence';
import { ACCOUNT_CLIENT_ID } from '../oidc/provider';

/** Who is acting on their own account: the person themselves, at sign-in or on the account page. */
export interface Self {
  identityId: string;
  displayName: string;
  email: string;
}

/** The account page's own client (static in oidc-provider, not in oidc_client), as the sessions list names it. */
const ACCOUNT_APP = { clientId: ACCOUNT_CLIENT_ID, name: 'Account page' };

export const RECOVERY_CODE_COUNT = 10;
/** Ten groups of the same alphabet as TOTP keys, readable aloud: `k7m2-p9qx-4tz8`. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A recovery code as typed: lowercase, no spaces or dashes. */
export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A person's own account: what they must do at sign-in (required actions), their password, recovery codes, second
 * steps and sessions. Every change is audited as the person themselves.
 */
@Injectable()
export class AccountService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
  ) {}

  private tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, this.tenant.id, fn);
  }

  /**
   * What is still required of them. configure_second_step is done once they have a second step (however they got
   * it), so it is dropped here rather than asked for again.
   */
  async requiredActions(self: Self): Promise<RequiredAction[]> {
    return this.tx(async (tx) => {
      const row = await tx.identity.findUnique({
        where: { id: self.identityId },
        select: { requiredActions: true },
      });
      const actions = (row?.requiredActions ?? []).filter(
        (a): a is RequiredAction => RequiredAction.safeParse(a).success,
      );
      if (!actions.includes('configure_second_step')) return actions;
      const second = await tx.credential.findFirst({
        where: { identityId: self.identityId, kind: { in: ['totp', 'passkey'] } },
        select: { id: true },
      });
      if (!second) return actions;
      await this.drop(tx, self, 'configure_second_step');
      return actions.filter((a) => a !== 'configure_second_step');
    });
  }

  /** Whether configure_second_step is required of them (the second step can't be skipped). */
  async mustConfigureSecondStep(identityId: string): Promise<boolean> {
    const row = await this.tx((tx) =>
      tx.identity.findUnique({ where: { id: identityId }, select: { requiredActions: true } }),
    );
    return Boolean(row?.requiredActions.includes('configure_second_step'));
  }

  async acceptTerms(self: Self): Promise<void> {
    await this.tx(async (tx) => {
      await tx.identity.update({ where: { id: self.identityId }, data: { termsAcceptedAt: new Date() } });
      await this.drop(tx, self, 'accept_terms');
      await appendAudit(tx, this.tenant.id, {
        ...this.actor(self),
        action: 'identity.terms_accepted',
        targetType: 'identity',
        targetId: self.identityId,
      });
    });
  }

  async checkPassword(identityId: string, password: string): Promise<boolean> {
    const credential = await this.tx((tx) =>
      tx.credential.findFirst({ where: { identityId, kind: 'password' }, orderBy: { createdAt: 'desc' } }),
    );
    return credential ? verifyPassword(credential.secret, password) : false;
  }

  /**
   * A new password: replaces the old one and clears update_password. `reset` (a one-time link: forgot password, or
   * an administrator's email) is audited as credential.password_reset; the caller ends their sessions.
   */
  async setPassword(self: Self, password: string, via: 'required_action' | 'account' | 'reset'): Promise<void> {
    const secret = await hashPassword(password);
    await this.tx(async (tx) => {
      await tx.credential.deleteMany({ where: { identityId: self.identityId, kind: 'password' } });
      await tx.credential.create({
        data: { tenantId: this.tenant.id, identityId: self.identityId, kind: 'password', secret },
      });
      await this.drop(tx, self, 'update_password');
      await appendAudit(tx, this.tenant.id, {
        ...this.actor(self),
        action: via === 'reset' ? 'credential.password_reset' : 'credential.password_set',
        targetType: 'identity',
        targetId: self.identityId,
        data: { via },
      });
    });
  }

  /** New recovery codes, shown once; the old ones stop working. Only SHA-256s are stored. */
  async newRecoveryCodes(self: Self): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const bytes = randomBytes(12);
      const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
      return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
    });
    await this.tx(async (tx) => {
      await tx.credential.deleteMany({ where: { identityId: self.identityId, kind: 'recovery_code' } });
      await tx.credential.createMany({
        data: codes.map((code) => ({
          tenantId: this.tenant.id,
          identityId: self.identityId,
          kind: 'recovery_code' as const,
          secret: sha256(normalizeRecoveryCode(code)),
        })),
      });
      await appendAudit(tx, this.tenant.id, {
        ...this.actor(self),
        action: 'credential.recovery_codes_created',
        targetType: 'identity',
        targetId: self.identityId,
        data: { count: codes.length },
      });
    });
    return codes;
  }

  /** Uses one recovery code (it is deleted, so it works once). Returns how many are left, or undefined if wrong. */
  async useRecoveryCode(self: Self, code: string): Promise<number | undefined> {
    const hash = sha256(normalizeRecoveryCode(code));
    return this.tx(async (tx) => {
      const used = await tx.credential.deleteMany({
        where: { identityId: self.identityId, kind: 'recovery_code', secret: hash },
      });
      if (used.count !== 1) return undefined;
      const left = await tx.credential.count({ where: { identityId: self.identityId, kind: 'recovery_code' } });
      await appendAudit(tx, this.tenant.id, {
        ...this.actor(self),
        action: 'credential.recovery_code_used',
        targetType: 'identity',
        targetId: self.identityId,
        data: { left },
      });
      return left;
    });
  }

  async hasRecoveryCodes(identityId: string): Promise<boolean> {
    const found = await this.tx((tx) =>
      tx.credential.findFirst({ where: { identityId, kind: 'recovery_code' }, select: { id: true } }),
    );
    return Boolean(found);
  }

  /** What the account page shows: their profile, second steps and recovery codes. */
  async overview(identityId: string) {
    return this.tx(async (tx) => {
      const identity = await tx.identity.findUniqueOrThrow({
        where: { id: identityId },
        include: {
          person: true,
          memberships: {
            where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            include: { group: { select: { name: true } } },
          },
          credentials: {
            select: { id: true, kind: true, label: true, createdAt: true, lastUsedAt: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: this.tenant.id },
        select: { mfaRequired: true, name: true },
      });
      return {
        identity,
        groups: identity.memberships.map((m) => ({ name: m.group.name, until: m.expiresAt })),
        password: identity.credentials.find((c) => c.kind === 'password'),
        totp: identity.credentials.find((c) => c.kind === 'totp'),
        passkeys: identity.credentials.filter((c) => c.kind === 'passkey'),
        recoveryCodes: identity.credentials.filter((c) => c.kind === 'recovery_code').length,
        mfaRequired: Boolean(tenant?.mfaRequired),
        tenantName: tenant?.name ?? '',
      };
    });
  }

  /**
   * Removes one of their second steps. Not the last one when their organization requires a second step; their
   * recovery codes go with the last one (they recover a second step that no longer exists).
   */
  async removeCredential(self: Self, id: string, mfaRequired: boolean): Promise<'removed' | 'last' | 'missing'> {
    return this.tx(async (tx) => {
      const credential = await tx.credential.findFirst({
        where: { id, identityId: self.identityId, kind: { in: ['totp', 'passkey'] } },
      });
      if (!credential) return 'missing';
      const others = await tx.credential.count({
        where: { identityId: self.identityId, kind: { in: ['totp', 'passkey'] }, id: { not: id } },
      });
      if (others === 0 && mfaRequired) return 'last';
      await tx.credential.delete({ where: { id } });
      if (others === 0)
        await tx.credential.deleteMany({ where: { identityId: self.identityId, kind: 'recovery_code' } });
      await appendAudit(tx, this.tenant.id, {
        ...this.actor(self),
        action: 'credential.removed',
        targetType: 'identity',
        targetId: self.identityId,
        data: { kind: credential.kind, label: credential.label },
      });
      return 'removed';
    });
  }

  /** Their sign-in sessions (oidc-provider's), newest first, with the names of the apps each signed in to. */
  async sessions(identityId: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; payload: Record<string, unknown> }>>`
      SELECT id, payload FROM oidc_payload
      WHERE type = 'Session' AND payload->>'accountId' = ${identityId}
        AND (expires_at IS NULL OR expires_at > now())`;
    const clientIds = [
      ...new Set(rows.flatMap((r) => Object.keys((r.payload.authorizations as object | undefined) ?? {}))),
    ];
    const clients = await this.tx((tx) =>
      tx.oidcClient.findMany({ where: { clientId: { in: clientIds } }, select: { clientId: true, name: true } }),
    );
    const names = new Map<string, string>([
      [ACCOUNT_APP.clientId, ACCOUNT_APP.name],
      ...clients.map((c): [string, string] => [c.clientId, c.name]),
    ]);
    return rows
      .map((r) => ({
        id: r.id,
        signedInAt: new Date(Number(r.payload.loginTs ?? 0) * 1000),
        acr: (r.payload.acr as string | undefined) ?? null,
        amr: (r.payload.amr as string[] | undefined) ?? [],
        apps: Object.keys((r.payload.authorizations as object | undefined) ?? {}).map((id) => names.get(id) ?? id),
      }))
      .sort((a, b) => b.signedInAt.getTime() - a.signedInAt.getTime());
  }

  /**
   * Ends their sessions, except `keepId` (this browser's session id). Applications' tokens run out on their own (an hour at
   * most); refresh tokens and grants stay unless the person is deactivated.
   */
  async endSessions(self: Self, keepId?: string): Promise<number> {
    const ended = keepId
      ? await this.prisma.$executeRaw`DELETE FROM oidc_payload WHERE type = 'Session'
          AND payload->>'accountId' = ${self.identityId} AND id <> ${keepId}`
      : await this.prisma.$executeRaw`DELETE FROM oidc_payload WHERE type = 'Session'
          AND payload->>'accountId' = ${self.identityId}`;
    if (ended)
      await this.tx((tx) =>
        appendAudit(tx, this.tenant.id, {
          ...this.actor(self),
          action: 'session.others_ended',
          targetType: 'identity',
          targetId: self.identityId,
          data: { ended, kept: Boolean(keepId) },
        }),
      );
    return ended;
  }

  private async drop(tx: Prisma.TransactionClient, self: Self, action: RequiredAction): Promise<void> {
    const row = await tx.identity.findUnique({ where: { id: self.identityId }, select: { requiredActions: true } });
    if (!row?.requiredActions.includes(action)) return;
    await tx.identity.update({
      where: { id: self.identityId },
      data: { requiredActions: row.requiredActions.filter((a) => a !== action) },
    });
  }

  private actor(self: Self) {
    return { actorId: self.identityId, actorLabel: self.displayName };
  }
}
