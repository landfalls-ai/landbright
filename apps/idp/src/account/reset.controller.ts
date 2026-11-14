import { Body, Controller, Get, Inject, Logger, Param, Post, Query, Req, Res } from '@nestjs/common';
import { type Config, newToken, Public, sha256 } from '@landbright/platform';
import {
  CONFIG,
  MIN_PASSWORD_LENGTH,
  PRISMA,
  type PrismaClient,
  TENANT,
  type TenantRef,
  withTenant,
} from '@landbright/persistence';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { Mailer } from '../mail/mailer';
import { forgotPage } from '../pages/account-pages';
import { invitePage, messagePage } from '../pages/pages';
import { VALKEY } from '../valkey';
import { AccountService } from './account.service';

export const RESET_TTL_MINUTES = 30;
/** Per address: links sent in an hour. Per client address: requests in 15 minutes. */
export const RESETS_PER_EMAIL_PER_HOUR = 3;
export const RESETS_PER_IP = 10;

/** An interaction uid, as oidc-provider makes them: only these characters make it into a link back. */
const UID = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * Forgot password, and the one-time link it sends. Public: the person can't sign in. The answer is the same whether
 * or not the address is someone's, and the same speed (the mail goes out after the response); sending is limited per
 * address and per client. A reset ends every session of theirs.
 */
@Public()
@Controller()
export class ResetController {
  private readonly logger = new Logger(ResetController.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly mailer: Mailer,
    private readonly account: AccountService,
  ) {}

  @Get('forgot')
  show(@Query('uid') uid: string | undefined, @Res() res: Response): void {
    this.page(res, 200, forgotPage({ action: this.action(uid), back: this.back(uid) }));
  }

  @Post('forgot')
  async request(
    @Query('uid') uid: string | undefined,
    @Body() body: { email?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const email = String(body?.email ?? '')
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254)
      return this.page(
        res,
        200,
        forgotPage({ action: this.action(uid), back: this.back(uid), email, error: 'Enter an email address.' }),
      );
    const from = req.ip ?? 'unknown';
    if ((await this.count(`lb:reset:ip:${this.tenant.id}:${from}`, 15 * 60)) > RESETS_PER_IP)
      return this.page(
        res,
        429,
        forgotPage({
          action: this.action(uid),
          back: this.back(uid),
          email,
          error: 'Too many requests from here. Try again in 15 minutes.',
        }),
      );
    this.page(res, 200, forgotPage({ action: this.action(uid), back: this.back(uid), email, sent: true }));
    // After the response, so a known address doesn't answer more slowly than an unknown one.
    void this.send(email, from).catch((error: unknown) =>
      this.logger.warn(`reset link not sent: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  @Get('reset/:token')
  async showReset(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const link = await this.find(token);
    if (!link) return this.expired(res);
    this.page(res, 200, this.form(token, link.identity.displayName, link.identity.email ?? ''));
  }

  @Post('reset/:token')
  async reset(
    @Param('token') token: string,
    @Body() body: { password?: string; confirm?: string },
    @Res() res: Response,
  ): Promise<void> {
    const link = await this.find(token);
    if (!link) return this.expired(res);
    const password = String(body?.password ?? '');
    const name = link.identity.displayName;
    const email = link.identity.email ?? '';
    if (password.length < MIN_PASSWORD_LENGTH)
      return this.page(res, 200, this.form(token, name, email, `Use at least ${MIN_PASSWORD_LENGTH} characters.`));
    if (password !== String(body?.confirm ?? ''))
      return this.page(res, 200, this.form(token, name, email, 'The two passwords don’t match.'));
    // Claim the link first, so two submissions can't both use it.
    const claimed = await withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.inviteToken.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: new Date() } }),
    );
    if (claimed.count === 0) return this.expired(res);
    const self = { identityId: link.identityId, displayName: name, email };
    await this.account.setPassword(self, password, 'reset');
    await this.account.endSessions(self);
    this.page(
      res,
      200,
      messagePage(
        'Your password is changed',
        'Sign in to your organization’s apps with your new password. You were signed out everywhere else.',
      ),
    );
  }

  private async send(email: string, from: string): Promise<void> {
    if ((await this.count(`lb:reset:email:${this.tenant.id}:${email}`, 3600)) > RESETS_PER_EMAIL_PER_HOUR) return;
    const { token, hash } = newToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);
    const person = await withTenant(this.prisma, this.tenant.id, async (tx) => {
      const identity = await tx.identity.findFirst({
        where: { email, kind: 'person', status: 'active' },
        include: { person: true },
      });
      if (!identity) return undefined;
      await tx.inviteToken.deleteMany({ where: { identityId: identity.id, usedAt: null, purpose: 'reset' } });
      await tx.inviteToken.create({
        data: { tenantId: this.tenant.id, identityId: identity.id, tokenHash: hash, expiresAt, purpose: 'reset' },
      });
      return identity;
    });
    if (!person) return;
    await this.mailer.sendReset({
      to: email,
      name: person.person?.givenName || person.displayName,
      link: new URL(`/reset/${token}`, this.config.LANDBRIGHT_IDP_URL).href,
      minutes: RESET_TTL_MINUTES,
      from,
    });
  }

  /** Counts one more in a window; fails open (Valkey down: no limit), like the sign-in lockout. */
  private async count(key: string, seconds: number): Promise<number> {
    try {
      const [[, n]] = (await this.valkey.multi().incr(key).expire(key, seconds, 'NX').exec()) as [[null, number]];
      return n;
    } catch {
      return 0;
    }
  }

  private find(token: string) {
    return withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.inviteToken.findFirst({
        where: {
          tokenHash: sha256(token),
          purpose: 'reset',
          usedAt: null,
          expiresAt: { gt: new Date() },
          identity: { status: 'active' },
        },
        include: { identity: true },
      }),
    );
  }

  private form(token: string, name: string, email: string, error?: string): string {
    return invitePage({
      action: `/reset/${encodeURIComponent(token)}`,
      name,
      email,
      error,
      title: 'Choose a new password',
      heading: 'Choose a new password',
      intro: `For ${email}. You’ll be signed out everywhere else.`,
      button: 'Save password',
    });
  }

  private expired(res: Response): void {
    this.page(
      res,
      404,
      messagePage('This link has expired', 'Ask for a new one from the sign-in page (Forgot your password?).'),
    );
  }

  private action(uid?: string): string {
    return uid && UID.test(uid) ? `/forgot?uid=${uid}` : '/forgot';
  }

  private back(uid?: string): string {
    return uid && UID.test(uid) ? `/interaction/${uid}` : '/account';
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
