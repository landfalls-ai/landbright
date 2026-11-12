import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { Public } from '@landbright/platform';
import type { Request, Response } from 'express';
import type { OidcProviderRef } from '../oidc/provider-ref';
import { enrollTotpPage, errorPage, loginPage, secondStepPage } from '../pages/pages';
import { OIDC_PROVIDER } from '../valkey';
import { LoginService } from './login.service';
import { PasskeyService } from './passkey.service';
import { type Pending, SecondStepService } from './second-step.service';
import { groupSecret, totpQrCode } from './totp';

/**
 * Landbright's sign-in pages for oidc-provider's interactions. Public: this is where people who aren't signed in
 * yet go. A password and then a second step (an authenticator app or a passkey), or a passkey alone.
 *
 * `amr` (RFC 8176) says how: `pwd`, `otp`, `pop` (a passkey), and `mfa` whenever two factors were used. A passkey
 * requires user verification, so it is two factors on its own.
 */
@Public()
@Controller('interaction')
export class InteractionController {
  constructor(
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProviderRef,
    private readonly login: LoginService,
    private readonly secondStep: SecondStepService,
    private readonly passkeys: PasskeyService,
  ) {}

  @Get(':uid')
  async show(@Param('uid') uid: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const details = await this.details(req, res);
    if (!details) return;
    if (details.uid !== uid) return this.page(res, 400, errorPage('This sign-in link doesn’t match your session.'));
    if (details.prompt.name !== 'login') {
      // Consent is never needed (loadExistingGrant grants registered apps); finish with what was asked.
      await this.oidc.current.interactionFinished(req, res, {}, { mergeWithLastSubmission: true });
      return;
    }
    await this.renderLogin(res, uid, details, {
      email: typeof details.params.login_hint === 'string' ? details.params.login_hint : undefined,
    });
  }

  @Post(':uid/login')
  async submit(
    @Param('uid') uid: string,
    @Body() body: { email?: string; password?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const details = await this.details(req, res, uid);
    if (!details) return;
    const email = String(body?.email ?? '');
    const result = await this.login.verify(email, String(body?.password ?? ''), req.ip ?? 'unknown');
    if (!result.ok) {
      const error =
        result.reason === 'locked'
          ? 'Too many attempts for this email. Try again in 15 minutes.'
          : 'That email and password don’t match.';
      return this.renderLogin(res, uid, details, { email, error });
    }
    const pending = await this.secondStep.next(uid, result);
    if (pending) return this.showSecondStep(res, uid, pending);
    await this.finish(req, res, result, ['pwd']);
  }

  /** The second step: a code from the person's authenticator app. */
  @Post(':uid/totp')
  async totp(
    @Param('uid') uid: string,
    @Body() body: { code?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const pending = await this.pending(req, res, uid, 'verify');
    if (!pending) return;
    if (!pending.totp) return this.page(res, 400, errorPage('This sign-in has expired. Start again from the app.'));
    if (await this.login.locked(pending.email))
      return this.showSecondStep(res, uid, pending, 'Too many attempts for this email. Try again in 15 minutes.');
    if (!(await this.secondStep.verify(pending, String(body?.code ?? '')))) {
      await this.login.secondStepFailed(pending.identityId, pending.displayName, pending.email, req.ip ?? 'unknown');
      return this.showSecondStep(
        res,
        uid,
        pending,
        'That code didn’t work. Codes change every 30 seconds, and each works once.',
      );
    }
    await this.secondStep.clear(uid);
    await this.finish(req, res, pending, ['pwd', 'otp', 'mfa']);
  }

  /** Setting up an authenticator app: the first code confirms it. */
  @Post(':uid/totp/enroll')
  async enroll(
    @Param('uid') uid: string,
    @Body() body: { code?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const pending = await this.pending(req, res, uid, 'enroll');
    if (!pending) return;
    if (!(await this.secondStep.enroll(pending, String(body?.code ?? '')))) {
      return this.showSecondStep(
        res,
        uid,
        pending,
        'That code didn’t match. Check the app shows Landbright and try the newest code.',
      );
    }
    await this.secondStep.clear(uid);
    await this.finish(req, res, pending, ['pwd', 'otp', 'mfa']);
  }

  /** Signing in with a passkey alone, from the sign-in page. */
  @Post(':uid/passkey')
  async passkey(
    @Param('uid') uid: string,
    @Body() body: { response?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const details = await this.details(req, res, uid);
    if (!details) return;
    if (!this.passkeys.available) return this.page(res, 404, errorPage('Passkeys aren’t switched on here.'));
    const result = await this.passkeys.authenticate(uid, String(body?.response ?? ''));
    if (!result.ok) {
      if (result.owner) await this.passkeyFailed(req, result.owner);
      return this.renderLogin(res, uid, details, {
        error: 'That passkey didn’t work here. Try again, or use your password.',
      });
    }
    await this.secondStep.clear(uid);
    await this.finish(req, res, result.owner, ['pop', 'mfa']);
  }

  /** The second step with a passkey, after the password. It must be this person's passkey. */
  @Post(':uid/passkey/verify')
  async passkeyVerify(
    @Param('uid') uid: string,
    @Body() body: { response?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const pending = await this.pending(req, res, uid, 'verify');
    if (!pending) return;
    if (!pending.passkey) return this.page(res, 400, errorPage('This sign-in has expired. Start again from the app.'));
    if (await this.login.locked(pending.email))
      return this.showSecondStep(res, uid, pending, 'Too many attempts for this email. Try again in 15 minutes.');
    const result = await this.passkeys.authenticate(uid, String(body?.response ?? ''), pending.identityId);
    if (!result.ok) {
      await this.passkeyFailed(req, pending);
      return this.showSecondStep(
        res,
        uid,
        pending,
        'That passkey didn’t work. Use the one you set up for this account.',
      );
    }
    await this.secondStep.clear(uid);
    await this.finish(req, res, pending, ['pwd', 'pop', 'mfa']);
  }

  /** Adding a passkey as the second step, when offered one. */
  @Post(':uid/passkey/enroll')
  async passkeyEnroll(
    @Param('uid') uid: string,
    @Body() body: { response?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const pending = await this.pending(req, res, uid, 'enroll');
    if (!pending) return;
    if (!this.passkeys.available) return this.page(res, 404, errorPage('Passkeys aren’t switched on here.'));
    if (!(await this.passkeys.register(uid, pending, String(body?.response ?? '')))) {
      return this.showSecondStep(
        res,
        uid,
        pending,
        'The passkey wasn’t added. Try again, or use an authenticator app.',
      );
    }
    await this.secondStep.clear(uid);
    await this.finish(req, res, pending, ['pwd', 'pop', 'mfa']);
  }

  /** "Not now", when the tenant doesn't require a second step. */
  @Post(':uid/totp/skip')
  async skip(@Param('uid') uid: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const pending = await this.pending(req, res, uid, 'enroll');
    if (!pending) return;
    if (pending.required) return this.showSecondStep(res, uid, pending, 'Your organization requires a second step.');
    await this.secondStep.skip(pending.identityId);
    await this.secondStep.clear(uid);
    await this.finish(req, res, pending, ['pwd']);
  }

  @Get(':uid/abort')
  async abort(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!(await this.details(req, res))) return;
    await this.oidc.current.interactionFinished(
      req,
      res,
      { error: 'access_denied', error_description: 'The person cancelled sign-in.' },
      { mergeWithLastSubmission: false },
    );
  }

  private async finish(
    req: Request,
    res: Response,
    who: { identityId: string; email: string; displayName: string },
    amr: string[],
  ): Promise<void> {
    await this.login.signedIn(who.identityId, who.displayName, who.email, amr, req.ip ?? 'unknown');
    await this.oidc.current.interactionFinished(
      req,
      res,
      { login: { accountId: who.identityId, amr } },
      { mergeWithLastSubmission: false },
    );
  }

  private async renderLogin(
    res: Response,
    uid: string,
    details: { params: Record<string, unknown> },
    opts: { email?: string; error?: string },
  ): Promise<void> {
    const client = await this.oidc.current.Client.find(String(details.params.client_id));
    this.page(
      res,
      200,
      loginPage({
        action: `/interaction/${uid}/login`,
        abort: `/interaction/${uid}/abort`,
        clientName: client?.clientName,
        ...opts,
        passkey: this.passkeys.available
          ? { action: `/interaction/${uid}/passkey`, options: await this.passkeys.authenticationOptions(uid) }
          : undefined,
      }),
    );
  }

  private async showSecondStep(res: Response, uid: string, pending: Pending, error?: string): Promise<void> {
    const abort = `/interaction/${uid}/abort`;
    if (pending.mode === 'verify') {
      return this.page(
        res,
        200,
        secondStepPage({
          totp: pending.totp ? { action: `/interaction/${uid}/totp` } : undefined,
          passkey: pending.passkey
            ? {
                action: `/interaction/${uid}/passkey/verify`,
                options: await this.passkeys.authenticationOptions(uid, pending.identityId),
              }
            : undefined,
          abort,
          email: pending.email,
          error,
        }),
      );
    }
    this.page(
      res,
      200,
      enrollTotpPage({
        action: `/interaction/${uid}/totp/enroll`,
        skip: pending.required ? undefined : `/interaction/${uid}/totp/skip`,
        abort,
        qr: await totpQrCode(pending.secret!, pending.email, 'Landbright'),
        secret: groupSecret(pending.secret!),
        error,
        passkey: this.passkeys.available
          ? {
              action: `/interaction/${uid}/passkey/enroll`,
              options: await this.passkeys.registrationOptions(uid, pending),
            }
          : undefined,
      }),
    );
  }

  private async passkeyFailed(req: Request, who: { identityId: string; email: string; displayName: string }) {
    await this.login.secondStepFailed(who.identityId, who.displayName, who.email, req.ip ?? 'unknown', 'passkey');
  }

  /** The person between steps of this sign-in, in this browser (interactionDetails checks the interaction cookie). */
  private async pending(req: Request, res: Response, uid: string, mode: Pending['mode']): Promise<Pending | undefined> {
    if (!(await this.details(req, res, uid))) return undefined;
    const pending = await this.secondStep.get(uid);
    if (!pending || pending.mode !== mode) {
      this.page(res, 400, errorPage('This sign-in has expired. Start again from the app.'));
      return undefined;
    }
    return pending;
  }

  private async details(req: Request, res: Response, uid?: string) {
    try {
      const details = await this.oidc.current.interactionDetails(req, res);
      if (uid && details.uid !== uid) throw new Error('uid mismatch');
      return details;
    } catch {
      this.page(res, 400, errorPage('This sign-in has expired or was already used.'));
      return undefined;
    }
  }

  private page(res: Response, status: number, body: string): void {
    res.status(status).type('html').setHeader('cache-control', 'no-store').send(body);
  }
}
