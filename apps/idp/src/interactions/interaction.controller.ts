import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { Public } from '@landbright/platform';
import type { Request, Response } from 'express';
import type Provider from 'oidc-provider';
import { errorPage, loginPage } from '../pages/pages';
import { OIDC_PROVIDER } from '../valkey';
import { LoginService } from './login.service';

/**
 * Landbright's sign-in pages for oidc-provider's interactions. Public: this is where people who aren't signed in
 * yet go. Wave 1 signs in with a password; TOTP and passkeys come next.
 */
@Public()
@Controller('interaction')
export class InteractionController {
  constructor(
    @Inject(OIDC_PROVIDER) private readonly provider: Provider,
    private readonly login: LoginService,
  ) {}

  @Get(':uid')
  async show(@Param('uid') uid: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const details = await this.details(req, res);
    if (!details) return;
    if (details.uid !== uid) return this.page(res, 400, errorPage('This sign-in link doesn’t match your session.'));
    if (details.prompt.name !== 'login') {
      // Consent is never needed (loadExistingGrant grants registered apps); finish with what was asked.
      await this.provider.interactionFinished(req, res, {}, { mergeWithLastSubmission: true });
      return;
    }
    const client = await this.provider.Client.find(String(details.params.client_id));
    this.page(
      res,
      200,
      loginPage({
        action: `/interaction/${uid}/login`,
        abort: `/interaction/${uid}/abort`,
        clientName: client?.clientName,
        email: typeof details.params.login_hint === 'string' ? details.params.login_hint : undefined,
      }),
    );
  }

  @Post(':uid/login')
  async submit(
    @Param('uid') uid: string,
    @Body() body: { email?: string; password?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const details = await this.details(req, res);
    if (!details) return;
    const email = String(body?.email ?? '');
    const result = await this.login.verify(email, String(body?.password ?? ''), req.ip ?? 'unknown');
    if (!result.ok) {
      const client = await this.provider.Client.find(String(details.params.client_id));
      const error =
        result.reason === 'locked'
          ? 'Too many attempts for this email. Try again in 15 minutes.'
          : 'That email and password don’t match.';
      return this.page(
        res,
        200,
        loginPage({
          action: `/interaction/${uid}/login`,
          abort: `/interaction/${uid}/abort`,
          clientName: client?.clientName,
          email,
          error,
        }),
      );
    }
    await this.provider.interactionFinished(
      req,
      res,
      { login: { accountId: result.identityId } },
      { mergeWithLastSubmission: false },
    );
  }

  @Get(':uid/abort')
  async abort(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!(await this.details(req, res))) return;
    await this.provider.interactionFinished(
      req,
      res,
      { error: 'access_denied', error_description: 'The person cancelled sign-in.' },
      { mergeWithLastSubmission: false },
    );
  }

  private async details(req: Request, res: Response) {
    try {
      return await this.provider.interactionDetails(req, res);
    } catch {
      this.page(res, 400, errorPage('This sign-in has expired or was already used.'));
      return undefined;
    }
  }

  private page(res: Response, status: number, body: string): void {
    res.status(status).type('html').setHeader('cache-control', 'no-store').send(body);
  }
}
