import { Body, Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import { sha256, Public } from '@landbright/platform';
import {
  appendAudit,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  PRISMA,
  type PrismaClient,
  TENANT,
  type TenantRef,
  withTenant,
} from '@landbright/persistence';
import type { Response } from 'express';
import { invitePage, messagePage } from '../pages/pages';

/**
 * The link in an invite email: set a password, once. Public: the person isn't signed in yet; the token in the path is
 * the credential, and only its SHA-256 is stored.
 */
@Public()
@Controller('invite')
export class InviteController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
  ) {}

  @Get(':token')
  async show(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const invite = await this.find(token);
    if (!invite)
      return this.page(res, 404, messagePage('This link has expired', 'Ask your administrator for a new invite.'));
    this.page(
      res,
      200,
      invitePage({
        action: `/invite/${encodeURIComponent(token)}`,
        name: invite.identity.person?.givenName || invite.identity.displayName,
        email: invite.identity.email ?? '',
      }),
    );
  }

  @Post(':token')
  async accept(
    @Param('token') token: string,
    @Body() body: { password?: string; confirm?: string },
    @Res() res: Response,
  ): Promise<void> {
    const invite = await this.find(token);
    if (!invite)
      return this.page(res, 404, messagePage('This link has expired', 'Ask your administrator for a new invite.'));
    const password = String(body?.password ?? '');
    const retry = (error: string) =>
      this.page(
        res,
        200,
        invitePage({
          action: `/invite/${encodeURIComponent(token)}`,
          name: invite.identity.person?.givenName || invite.identity.displayName,
          email: invite.identity.email ?? '',
          error,
        }),
      );
    if (password.length < MIN_PASSWORD_LENGTH) return retry(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (password !== String(body?.confirm ?? '')) return retry('The two passwords don’t match.');

    const secret = await hashPassword(password);
    const tenantId = this.tenant.id;
    const used = await withTenant(this.prisma, tenantId, async (tx) => {
      // Claim the token first, so two submissions can't both use it.
      const claimed = await tx.inviteToken.updateMany({
        where: { id: invite.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      await tx.credential.deleteMany({ where: { identityId: invite.identityId, kind: 'password' } });
      await tx.credential.create({ data: { tenantId, identityId: invite.identityId, kind: 'password', secret } });
      await appendAudit(tx, tenantId, {
        actorId: invite.identityId,
        actorLabel: invite.identity.displayName,
        action: 'credential.password_set',
        targetType: 'identity',
        targetId: invite.identityId,
        data: { via: 'invite' },
      });
      return true;
    });
    if (!used)
      return this.page(res, 404, messagePage('This link has expired', 'Ask your administrator for a new invite.'));
    this.page(
      res,
      200,
      messagePage(
        'Your password is set',
        'You can now sign in to your organization’s apps with Landbright. You can close this page.',
      ),
    );
  }

  private find(token: string) {
    return withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.inviteToken.findFirst({
        where: { tokenHash: sha256(token), purpose: 'invite', usedAt: null, expiresAt: { gt: new Date() } },
        include: { identity: { include: { person: true } } },
      }),
    );
  }

  private page(res: Response, status: number, body: string): void {
    res
      .status(status)
      .type('html')
      .setHeader('cache-control', 'no-store')
      .setHeader('referrer-policy', 'no-referrer')
      .send(body);
  }
}
