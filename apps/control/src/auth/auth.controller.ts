import { Controller, Get, Inject, Logger, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { type Config, Public } from '@landbright/platform';
import {
  appendAudit,
  CONFIG,
  PRISMA,
  type PrismaClient,
  TENANT,
  type TenantRef,
  withTenant,
} from '@landbright/persistence';
import { type Logout, Me } from '@landbright/contracts';
import type { Request, Response } from 'express';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import * as oidc from 'openid-client';
import type { WithPrincipal } from '../common/principal';
import { ConsoleOidc } from './console-oidc';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, SessionStore } from './session.store';

class MeDto extends createZodDto(Me) {}

/** Only paths on the console itself: never an absolute URL, never `//host`. */
function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/';
}

@ApiTags('Session')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly oidcClient: ConsoleOidc,
    private readonly sessions: SessionStore,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
  ) {}

  // Public: this is how someone who isn't signed in starts signing in.
  @Public()
  @Get('login')
  @ApiExcludeEndpoint()
  async login(@Query('returnTo') returnTo: string | undefined, @Res() res: Response): Promise<void> {
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    await this.sessions.savePending(state, { codeVerifier, nonce, returnTo: safeReturnTo(returnTo) });
    const url = await this.oidcClient.authorizationUrl({
      state,
      nonce,
      codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    });
    res.redirect(302, url.href);
  }

  // Public: the identity plane sends the browser back here with the code.
  @Public()
  @Get('callback')
  @ApiExcludeEndpoint()
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const pending = state ? await this.sessions.takePending(state) : undefined;
    if (!pending) return res.redirect(302, '/?signin=expired');
    const callbackUrl = new URL(req.originalUrl, this.config.LANDBRIGHT_CONSOLE_URL);
    try {
      const { claims, idToken } = await this.oidcClient.exchange(callbackUrl, {
        state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
      });
      const sessionId = await this.sessions.create({
        identityId: claims.sub,
        idToken,
        createdAt: new Date().toISOString(),
      });
      await withTenant(this.prisma, this.tenant.id, (tx) =>
        appendAudit(tx, this.tenant.id, {
          actorId: claims.sub,
          actorLabel: String(claims.name ?? claims.email ?? claims.sub),
          action: 'console.signed_in',
          targetType: 'identity',
          targetId: claims.sub,
        }),
      );
      res.cookie(SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: callbackUrl.protocol === 'https:',
        path: '/',
        maxAge: SESSION_TTL_SECONDS * 1000,
      });
      res.redirect(302, pending.returnTo);
    } catch (error) {
      this.logger.warn(`console sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      res.redirect(302, '/?signin=failed');
    }
  }

  @Get('me')
  @ZodResponse({ type: MeDto })
  me(@Req() req: Request & WithPrincipal): Me {
    const p = req.principal;
    if (!p) throw new UnauthorizedException();
    return {
      id: p.id,
      displayName: p.displayName,
      email: p.email,
      admin: p.admin,
      tenant: { slug: this.tenant.slug, name: this.tenant.name },
    };
  }

  /** Ends the console session and returns where to send the browser to end the Landbright session too. */
  @Post('logout')
  async logout(@Req() req: Request & WithPrincipal, @Res({ passthrough: true }) res: Response): Promise<Logout> {
    const p = req.principal;
    if (!p) throw new UnauthorizedException();
    const session = await this.sessions.get(p.sessionId);
    await this.sessions.destroy(p.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { redirect: session ? await this.oidcClient.endSessionUrl(session.idToken) : '/' };
  }
}
