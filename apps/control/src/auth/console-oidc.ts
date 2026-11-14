import { Inject, Injectable } from '@nestjs/common';
import { type Config, clientSecret, issuerOf } from '@landbright/platform';
import { CONFIG, consoleClientId, TENANT, type TenantRef } from '@landbright/persistence';
import * as oidc from 'openid-client';

/**
 * The console signs in with Landbright like any other application: control is a confidential OIDC client
 * (authorization code + PKCE) of the identity plane, and keeps the session server-side (a backend for the frontend).
 * Discovery happens on first use, so control starts even while the identity plane is still starting.
 */
@Injectable()
export class ConsoleOidc {
  private configuration?: Promise<oidc.Configuration>;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(TENANT) private readonly tenant: TenantRef,
  ) {}

  get redirectUri(): string {
    return new URL('/api/auth/callback', this.config.LANDBRIGHT_CONSOLE_URL).href;
  }

  async authorizationUrl(params: { state: string; nonce: string; codeChallenge: string }): Promise<URL> {
    return oidc.buildAuthorizationUrl(await this.discover(), {
      redirect_uri: this.redirectUri,
      scope: 'openid email profile roles',
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  async exchange(callbackUrl: URL, expected: { state: string; nonce: string; codeVerifier: string }) {
    const tokens = await oidc.authorizationCodeGrant(await this.discover(), callbackUrl, {
      expectedState: expected.state,
      expectedNonce: expected.nonce,
      pkceCodeVerifier: expected.codeVerifier,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('The identity plane returned no ID token.');
    return { claims, idToken: tokens.id_token! };
  }

  async endSessionUrl(idToken: string): Promise<string> {
    return oidc
      .buildEndSessionUrl(await this.discover(), {
        id_token_hint: idToken,
        post_logout_redirect_uri: new URL('/', this.config.LANDBRIGHT_CONSOLE_URL).href,
      })
      .toString();
  }

  private discover(): Promise<oidc.Configuration> {
    this.configuration ??= oidc
      .discovery(
        new URL(issuerOf(this.config)),
        consoleClientId(this.tenant.slug),
        clientSecret(this.config.LANDBRIGHT_SECRET_KEY, consoleClientId(this.tenant.slug), 1),
        undefined,
        // Local development serves the issuer over http.
        new URL(issuerOf(this.config)).protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        this.configuration = undefined;
        throw error;
      });
    return this.configuration;
  }
}
