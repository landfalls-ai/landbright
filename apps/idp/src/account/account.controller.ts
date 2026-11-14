import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { type Config, deriveKey, Public } from '@landbright/platform';
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
import { PasskeyService } from '../interactions/passkey.service';
import { SecondStepService } from '../interactions/second-step.service';
import { groupSecret, newTotpSecret, totpQrCode } from '../interactions/totp';
import type { OidcProviderRef } from '../oidc/provider-ref';
import { ACCOUNT_CLIENT_ID, accountRedirectUri } from '../oidc/provider';
import { accountPage, recoveryCodesPage } from '../pages/account-pages';
import { enrollTotpPage, errorPage } from '../pages/pages';
import { OIDC_PROVIDER, VALKEY } from '../valkey';
import { AccountService, type Self } from './account.service';

/** Changing a second step or the recovery codes asks for a sign-in this recent (or signs them in again). */
export const RECENT_SIGN_IN_SECONDS = 15 * 60;

/** Messages the account page shows after a change, by key (the query string carries only the key). */
const FLASH: Record<string, { ok?: string; error?: string }> = {
  password: { ok: 'Your password is changed.' },
  removed: { ok: 'Removed.' },
  totp: { ok: 'Your authenticator app is set up.' },
  passkey: { ok: 'Your passkey is added.' },
  sessions: { ok: 'You’re signed out everywhere else.' },
  last: { error: 'Your organization requires a second step: add another before removing this one.' },
  'passkey-failed': { error: 'The passkey wasn’t added. Try again.' },
  wrong: { error: 'Your current password isn’t right.' },
  mismatch: { error: 'The two new passwords don’t match.' },
  short: { error: `Use at least ${MIN_PASSWORD_LENGTH} characters for the new password.` },
  expired: { error: 'That form had expired. Try again.' },
};

interface Signed {
  self: Self;
  sessionId: string;
  loginTs: number;
}

/**
 * The account page on the identity plane (Keycloak's account console, in one page): change the password, add or
 * remove an authenticator app and passkeys, recovery codes, and where you're signed in. Public routes because the
 * person signs in here, through Landbright's own `landbright-account` client: the session is oidc-provider's own
 * (its cookie), read on each request. Forms carry a token derived from the session (CSRF), and changes to second
 * steps ask for a recent sign-in.
 */
@Public()
@Controller('account')
export class AccountController {
  constructor(
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProviderRef,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly account: AccountService,
    private readonly secondStep: SecondStepService,
    private readonly passkeys: PasskeyService,
  ) {}

  @Get()
  async show(@Query('m') flash: string | undefined, @Req() req: Request, @Res() res: Response): Promise<void> {
    const signed = await this.signedIn(req, res);
    if (!signed) return this.signIn(res);
    const o = await this.account.overview(signed.self.identityId);
    const sessions = await this.account.sessions(signed.self.identityId);
    const csrf = this.csrf(signed.sessionId);
    this.page(
      res,
      200,
      accountPage({
        name: o.identity.displayName,
        email: o.identity.email ?? '',
        tenantName: o.tenantName,
        groups: o.groups,
        csrf,
        flash: flash ? FLASH[flash] : undefined,
        password: { set: Boolean(o.password), since: o.password?.createdAt },
        totp: o.totp && { id: o.totp.id, createdAt: o.totp.createdAt, lastUsedAt: o.totp.lastUsedAt },
        passkeys: o.passkeys,
        confirmFirst: this.passkeys.available && !this.recent(signed) ? '/account/confirm' : undefined,
        addPasskey:
          this.passkeys.available && this.recent(signed)
            ? {
                action: '/account/passkeys',
                options: await this.passkeys.registrationOptions(this.ceremony(signed), signed.self),
                fields: { csrf },
              }
            : undefined,
        recoveryCodes: o.recoveryCodes,
        mfaRequired: o.mfaRequired,
        sessions: sessions.map((s) => ({ ...s, current: s.id === signed.sessionId })),
        signOut: `/oidc/session/end?client_id=${ACCOUNT_CLIENT_ID}&post_logout_redirect_uri=${encodeURIComponent(
          new URL('/account', this.config.LANDBRIGHT_IDP_URL).href,
        )}`,
      }),
    );
  }

  /** Sign in again (a password and second step), before adding a passkey. */
  @Get('confirm')
  confirm(@Res() res: Response): void {
    this.signIn(res, { again: true });
  }

  /** Where the account client comes back to after sign-in. */
  @Get('signed-in')
  back(@Res() res: Response): void {
    res.redirect(303, '/account');
  }

  @Post('password')
  async password(
    @Body() body: { csrf?: string; current?: string; password?: string; confirm?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const signed = await this.form(req, res, body?.csrf);
    if (!signed) return;
    const password = String(body?.password ?? '');
    if (!(await this.account.checkPassword(signed.self.identityId, String(body?.current ?? ''))))
      return this.done(res, 'wrong');
    if (password.length < MIN_PASSWORD_LENGTH) return this.done(res, 'short');
    if (password !== String(body?.confirm ?? '')) return this.done(res, 'mismatch');
    await this.account.setPassword(signed.self, password, 'account');
    this.done(res, 'password');
  }

  @Post('credentials/:id/remove')
  async remove(
    @Param('id') id: string,
    @Body() body: { csrf?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const signed = await this.form(req, res, body?.csrf, { recent: true });
    if (!signed) return;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: this.tenant.id },
      select: { mfaRequired: true },
    });
    const result = await this.account.removeCredential(signed.self, id, Boolean(tenant?.mfaRequired));
    this.done(res, result === 'last' ? 'last' : 'removed');
  }

  @Post('recovery-codes')
  async recoveryCodes(@Body() body: { csrf?: string }, @Req() req: Request, @Res() res: Response): Promise<void> {
    const signed = await this.form(req, res, body?.csrf, { recent: true });
    if (!signed) return;
    const has = await withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.credential.count({ where: { identityId: signed.self.identityId, kind: { in: ['totp', 'passkey'] } } }),
    );
    if (!has) return this.done(res);
    this.page(res, 200, recoveryCodesPage(await this.account.newRecoveryCodes(signed.self)));
  }

  @Post('sessions/end-others')
  async endOthers(@Body() body: { csrf?: string }, @Req() req: Request, @Res() res: Response): Promise<void> {
    const signed = await this.form(req, res, body?.csrf);
    if (!signed) return;
    await this.account.endSessions(signed.self, signed.sessionId);
    this.done(res, 'sessions');
  }

  @Post('passkeys')
  async addPasskey(
    @Body() body: { csrf?: string; response?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const signed = await this.form(req, res, body?.csrf, { recent: true });
    if (!signed) return;
    if (!this.passkeys.available) return this.done(res, 'passkey-failed');
    const ok = await this.passkeys.register(this.ceremony(signed), signed.self, String(body?.response ?? ''));
    this.done(res, ok ? 'passkey' : 'passkey-failed');
  }

  /** Setting up an authenticator app: the key waits in Valkey for the first code. */
  @Get('totp')
  async totpForm(@Req() req: Request, @Res() res: Response): Promise<void> {
    const signed = await this.signedIn(req, res);
    if (!signed) return this.signIn(res);
    if (!this.recent(signed)) return this.signIn(res, { again: true });
    const secret = newTotpSecret();
    await this.valkey.set(this.totpKey(signed), secret, 'EX', 600);
    await this.totpPage(res, signed, secret);
  }

  @Post('totp')
  async totp(@Body() body: { code?: string }, @Req() req: Request, @Res() res: Response): Promise<void> {
    // No CSRF token here: the key this code must match was handed to this session's own page and never left it.
    const signed = await this.signedIn(req, res);
    if (!signed) return this.signIn(res);
    const secret = await this.valkey.get(this.totpKey(signed));
    if (!secret) return this.done(res, 'expired');
    const pending = { ...signed.self, mode: 'enroll' as const, totp: false, passkey: false, required: false, secret };
    if (!(await this.secondStep.enroll(pending, String(body?.code ?? ''))))
      return this.totpPage(
        res,
        signed,
        secret,
        'That code didn’t match. Check the app shows Landbright and try the newest code.',
      );
    await this.valkey.del(this.totpKey(signed));
    this.done(res, 'totp');
  }

  private async totpPage(res: Response, signed: Signed, secret: string, error?: string): Promise<void> {
    this.page(
      res,
      200,
      enrollTotpPage({
        action: '/account/totp',
        abort: '/account',
        cancelLabel: 'Back to your account',
        qr: await totpQrCode(secret, signed.self.email, 'Landbright'),
        secret: groupSecret(secret),
        intro: 'Scan the code with your authenticator app, then enter the 6-digit code it shows.',
        error,
      }),
    );
  }

  /** The person signed in to Landbright in this browser (oidc-provider's session), if any and still active. */
  private async signedIn(req: Request, res: Response): Promise<Signed | undefined> {
    const provider = this.oidc.current;
    const ctx = provider.createContext(req, res);
    const session = await provider.Session.get(ctx).catch(() => undefined);
    if (!session?.accountId) return undefined;
    const identity = await withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.identity.findFirst({ where: { id: session.accountId, kind: 'person', status: 'active' } }),
    );
    if (!identity) return undefined;
    return {
      self: { identityId: identity.id, displayName: identity.displayName, email: identity.email ?? '' },
      sessionId: session.jti,
      loginTs: Number(session.loginTs ?? 0),
    };
  }

  /** A form post: signed in, the session's CSRF token, and (for second steps) a recent sign-in. */
  private async form(
    req: Request,
    res: Response,
    token: string | undefined,
    opts: { recent?: boolean } = {},
  ): Promise<Signed | undefined> {
    const signed = await this.signedIn(req, res);
    if (!signed) {
      this.signIn(res);
      return undefined;
    }
    const expected = Buffer.from(this.csrf(signed.sessionId));
    const given = Buffer.from(String(token ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.page(res, 403, errorPage('This form expired. Go back to your account page and try again.'));
      return undefined;
    }
    if (opts.recent && !this.recent(signed)) {
      this.signIn(res, { again: true });
      return undefined;
    }
    return signed;
  }

  private recent(signed: Signed): boolean {
    return Date.now() / 1000 - signed.loginTs <= RECENT_SIGN_IN_SECONDS;
  }

  /**
   * To the authorization endpoint with the account client (response type `none`: a session, no tokens). `again`
   * asks for the password even when signed in (max_age=0), before a change to a second step.
   */
  private signIn(res: Response, opts: { again?: boolean } = {}): void {
    const url = new URL('/oidc/auth', this.config.LANDBRIGHT_IDP_URL);
    url.search = new URLSearchParams({
      client_id: ACCOUNT_CLIENT_ID,
      response_type: 'none',
      scope: 'openid',
      redirect_uri: accountRedirectUri(this.config),
      state: randomBytes(12).toString('base64url'),
      ...(opts.again && { max_age: '0' }),
    }).toString();
    res.redirect(303, url.pathname + url.search);
  }

  private csrf(sessionId: string): string {
    return createHmac('sha256', deriveKey(this.config.LANDBRIGHT_SECRET_KEY, 'account-csrf'))
      .update(sessionId)
      .digest('base64url');
  }

  /** The key a passkey ceremony's challenge is kept under: one per session. */
  private ceremony(signed: Signed): string {
    return `account:${signed.sessionId}`;
  }

  private totpKey(signed: Signed): string {
    return `lb:account:totp:${signed.sessionId}`;
  }

  private done(res: Response, flash?: string): void {
    res.redirect(303, flash ? `/account?m=${flash}` : '/account');
  }

  private page(res: Response, status: number, body: string): void {
    res.status(status).type('html').setHeader('cache-control', 'no-store').send(body);
  }
}
