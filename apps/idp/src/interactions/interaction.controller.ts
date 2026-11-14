import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ACR_LABELS, acrLevel, acrOf, neededAcr, type Acr, type RequiredAction } from '@landbright/contracts';
import { type Config, Public } from '@landbright/platform';
import { CONFIG, MIN_PASSWORD_LENGTH, TENANT, type TenantRef } from '@landbright/persistence';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { AccountService } from '../account/account.service';
import type { OidcProviderRef } from '../oidc/provider-ref';
import { termsPage } from '../pages/account-pages';
import { enrollTotpPage, errorPage, invitePage, loginPage, messagePage, secondStepPage } from '../pages/pages';
import { OIDC_PROVIDER, VALKEY } from '../valkey';
import { LoginService } from './login.service';
import { PasskeyService } from './passkey.service';
import { type Pending, SecondStepService } from './second-step.service';
import { groupSecret, totpQrCode } from './totp';

/**
 * Landbright's sign-in pages for oidc-provider's interactions. Public: this is where people who aren't signed in
 * yet go. A password and then a second step (an authenticator app or a passkey), or a passkey alone.
 *
 * `amr` (RFC 8176) says how: `pwd`, `otp` (an app's code, or a recovery code), `pop` (a passkey), and `mfa` whenever
 * two factors were used. A passkey requires user verification, so it is two factors on its own. `acr` follows from it
 * (libs/contracts/src/acr.ts); an application's `minimumAcr`, or the request's `acr_values`, can ask for more (a second
 * step, or a passkey), also from someone already signed in (step-up).
 *
 * Before the application gets its answer, the person does what is required of them (required actions: a new password,
 * a second step, the terms), held between pages in Valkey under the interaction.
 */
const ACTIONS_TTL_SECONDS = 900;

@Public()
@Controller('interaction')
export class InteractionController {
  constructor(
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProviderRef,
    private readonly login: LoginService,
    private readonly secondStep: SecondStepService,
    private readonly passkeys: PasskeyService,
    private readonly account: AccountService,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(TENANT) private readonly tenant: TenantRef,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get(':uid')
  async show(@Param('uid') uid: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const details = await this.details(req, res);
    if (!details) return;
    if (details.uid !== uid) return this.page(res, 400, errorPage('This sign-in link doesn’t match your session.'));
    if (details.prompt.name !== 'login') {
      // Consent is never shown (loadExistingGrant grants registered apps), but the prompt must be answered: an app that
      // asks for prompt=consent (offline_access does) would otherwise come back here forever.
      await this.oidc.current.interactionFinished(req, res, { consent: {} }, { mergeWithLastSubmission: true });
      return;
    }
    const needs = await this.needs(details);
    await this.renderLogin(res, uid, details, {
      email: typeof details.params.login_hint === 'string' ? details.params.login_hint : undefined,
      note: needs.note,
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
    const needs = await this.needs(details);
    const level = acrLevel(needs.acr);
    if (level >= 3 && !(await this.passkeys.has(result.identityId)))
      return this.page(
        res,
        403,
        messagePage(
          'This app needs a passkey',
          `${needs.clientName ?? 'This app'} only accepts a sign-in with a passkey, and you don’t have one yet. Add one on your account page (${this.accountUrl()}), then come back.`,
        ),
      );
    const pending = await this.secondStep.next(uid, result, {
      force: level >= 2 || (await this.account.mustConfigureSecondStep(result.identityId)),
      passkeyOnly: level >= 3,
      note: needs.note,
    });
    if (pending) return this.showSecondStep(res, uid, pending);
    await this.finish(req, res, uid, result, ['pwd']);
  }

  /** A recovery code instead of the second step. It works once, like a code from the app (`otp`). */
  @Post(':uid/recovery')
  async recovery(
    @Param('uid') uid: string,
    @Body() body: { code?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const pending = await this.pending(req, res, uid, 'verify');
    if (!pending) return;
    if (!pending.recovery) return this.page(res, 400, errorPage('This sign-in has expired. Start again from the app.'));
    if (await this.login.locked(pending.email))
      return this.showSecondStep(res, uid, pending, 'Too many attempts for this email. Try again in 15 minutes.');
    const left = await this.account.useRecoveryCode(pending, String(body?.code ?? ''));
    if (left === undefined) {
      await this.login.secondStepFailed(
        pending.identityId,
        pending.displayName,
        pending.email,
        req.ip ?? 'unknown',
        'recovery_code',
      );
      return this.showSecondStep(res, uid, pending, 'That recovery code didn’t work. Each one works once.');
    }
    await this.secondStep.clear(uid);
    await this.finish(req, res, uid, pending, ['pwd', 'otp', 'mfa']);
  }

  /** The update_password required action. */
  @Post(':uid/actions/password')
  async actionPassword(
    @Param('uid') uid: string,
    @Body() body: { password?: string; confirm?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const state = await this.actionState(req, res, uid);
    if (!state) return;
    const password = String(body?.password ?? '');
    let error: string | undefined;
    if (password.length < MIN_PASSWORD_LENGTH) error = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    else if (password !== String(body?.confirm ?? '')) error = 'The two passwords don’t match.';
    else if (await this.account.checkPassword(state.who.identityId, password))
      error = 'Choose a password you haven’t used here.';
    if (error) return this.showAction(res, uid, 'update_password', state.who, error);
    await this.account.setPassword(state.who, password, 'required_action');
    await this.finish(req, res, uid, state.who, state.amr);
  }

  /** The accept_terms required action. */
  @Post(':uid/actions/terms')
  async actionTerms(
    @Param('uid') uid: string,
    @Body() body: { accept?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const state = await this.actionState(req, res, uid);
    if (!state) return;
    if (body?.accept !== 'yes')
      return this.showAction(res, uid, 'accept_terms', state.who, 'Accept the terms to continue.');
    await this.account.acceptTerms(state.who);
    await this.finish(req, res, uid, state.who, state.amr);
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
    await this.finish(req, res, uid, pending, ['pwd', 'otp', 'mfa']);
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
    await this.finish(req, res, uid, pending, ['pwd', 'otp', 'mfa']);
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
    await this.finish(req, res, uid, result.owner, ['pop', 'mfa']);
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
    await this.finish(req, res, uid, pending, ['pwd', 'pop', 'mfa']);
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
    await this.finish(req, res, uid, pending, ['pwd', 'pop', 'mfa']);
  }

  /** "Not now", when the tenant doesn't require a second step. */
  @Post(':uid/totp/skip')
  async skip(@Param('uid') uid: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const pending = await this.pending(req, res, uid, 'enroll');
    if (!pending) return;
    if (pending.required) return this.showSecondStep(res, uid, pending, 'Your organization requires a second step.');
    await this.secondStep.skip(pending.identityId);
    await this.secondStep.clear(uid);
    await this.finish(req, res, uid, pending, ['pwd']);
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

  /**
   * They proved who they are: first what is required of them (each action's page, then back here), then the answer
   * to the application, with `amr` and the `acr` it earns.
   */
  private async finish(
    req: Request,
    res: Response,
    uid: string,
    who: { identityId: string; email: string; displayName: string },
    amr: string[],
  ): Promise<void> {
    const self = { identityId: who.identityId, email: who.email, displayName: who.displayName };
    const actions = await this.account.requiredActions(self);
    if (actions.length) {
      await this.valkey.set(this.actionsKey(uid), JSON.stringify({ who: self, amr }), 'EX', ACTIONS_TTL_SECONDS);
      if (actions[0] === 'configure_second_step') {
        const pending = await this.secondStep.next(uid, self, { force: true });
        if (pending) return this.showSecondStep(res, uid, pending);
      }
      return this.showAction(res, uid, actions[0]!, self);
    }
    await this.valkey.del(this.actionsKey(uid)).catch(() => undefined);
    await this.login.signedIn(who.identityId, who.displayName, who.email, amr, req.ip ?? 'unknown');
    await this.oidc.current.interactionFinished(
      req,
      res,
      { login: { accountId: who.identityId, amr, acr: acrOf(amr) } },
      { mergeWithLastSubmission: false },
    );
  }

  private showAction(
    res: Response,
    uid: string,
    action: RequiredAction,
    who: { email: string; displayName: string },
    error?: string,
  ): void {
    const abort = `/interaction/${uid}/abort`;
    if (action === 'accept_terms')
      return this.page(
        res,
        200,
        termsPage({
          action: `/interaction/${uid}/actions/terms`,
          tenantName: this.tenant.name,
          termsUrl: this.config.LANDBRIGHT_TERMS_URL || undefined,
          abort,
          error,
        }),
      );
    this.page(
      res,
      200,
      invitePage({
        action: `/interaction/${uid}/actions/password`,
        name: who.displayName,
        email: who.email,
        error,
        title: 'Choose a new password',
        heading: 'Choose a new password',
        intro: 'Your administrator asks you to choose a new password before you continue.',
        button: 'Save and continue',
      }),
    );
  }

  /** The person between required actions of this sign-in, in this browser. */
  private async actionState(req: Request, res: Response, uid: string) {
    if (!(await this.details(req, res, uid))) return undefined;
    const raw = await this.valkey.get(this.actionsKey(uid));
    if (!raw) {
      this.page(res, 400, errorPage('This sign-in has expired. Start again from the app.'));
      return undefined;
    }
    return JSON.parse(raw) as { who: { identityId: string; email: string; displayName: string }; amr: string[] };
  }

  private actionsKey(uid: string): string {
    return `lb:actions:${uid}`;
  }

  /**
   * What this sign-in must reach: the application's minimum and the request's `acr_values`, and a sentence saying so
   * when it is more than a password.
   */
  private async needs(details: { params: Record<string, unknown> }) {
    const client = await this.oidc.current.Client.find(String(details.params.client_id));
    const acr = neededAcr(
      client?.['minimum_acr'] as string | undefined,
      typeof details.params.acr_values === 'string' ? details.params.acr_values : undefined,
    );
    const name = client?.clientName;
    const note =
      acrLevel(acr) >= 2 ? `${name ?? 'This app'} asks for ${ACR_LABELS[acr as Acr].toLowerCase()}.` : undefined;
    return { acr, note, clientName: name };
  }

  private accountUrl(): string {
    return new URL('/account', this.config.LANDBRIGHT_IDP_URL).href;
  }

  private async renderLogin(
    res: Response,
    uid: string,
    details: { params: Record<string, unknown> },
    opts: { email?: string; error?: string; note?: string },
  ): Promise<void> {
    const client = await this.oidc.current.Client.find(String(details.params.client_id));
    this.page(
      res,
      200,
      loginPage({
        action: `/interaction/${uid}/login`,
        abort: `/interaction/${uid}/abort`,
        forgot: `/forgot?uid=${encodeURIComponent(uid)}`,
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
          recovery: pending.recovery ? { action: `/interaction/${uid}/recovery` } : undefined,
          note: pending.note,
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
        intro: pending.note ? `${pending.note} Set up an authenticator app or a passkey now.` : undefined,
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
