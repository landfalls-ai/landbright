import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Config, deriveKey } from '@landbright/platform';
import { CONFIG, PRISMA, type PrismaClient, TENANT, type TenantRef, withTenant } from '@landbright/persistence';
import type { Request, Response } from 'express';
import type { OidcProviderRef } from '../oidc/provider-ref';
import { ACCOUNT_CLIENT_ID, accountRedirectUri } from '../oidc/provider';
import { OIDC_PROVIDER } from '../valkey';
import type { Self } from './account.service';

export interface Signed {
  self: Self;
  sessionId: string;
  loginTs: number;
  amr?: string[];
  acr?: string;
}

/** Where to go after signing in, carried in `state`: the account page, or a CIBA decision page. */
const THEN = /^[A-Za-z0-9_-]+\.ciba\.([A-Za-z0-9_-]{10,64})$/;

/**
 * The person's own session on the identity plane, for Landbright's own pages (the account page, CIBA decisions): read
 * from oidc-provider's session cookie, signed in through Landbright's own `landbright-account` client, with a CSRF
 * token derived from the session.
 */
@Injectable()
export class SelfSession {
  constructor(
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProviderRef,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
  ) {}

  async signedIn(req: Request, res: Response): Promise<Signed | undefined> {
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
      amr: session.amr,
      acr: session.acr,
    };
  }

  /**
   * To the authorization endpoint with the account client (response type `none`: a session, no tokens). `again` asks
   * for the password even when signed in (max_age=0). `ciba` comes back to that decision page afterwards.
   */
  signIn(res: Response, opts: { again?: boolean; ciba?: string } = {}): void {
    const url = new URL('/oidc/auth', this.config.LANDBRIGHT_IDP_URL);
    const nonce = randomBytes(12).toString('base64url');
    url.search = new URLSearchParams({
      client_id: ACCOUNT_CLIENT_ID,
      response_type: 'none',
      scope: 'openid',
      redirect_uri: accountRedirectUri(this.config),
      state: opts.ciba ? `${nonce}.ciba.${opts.ciba}` : nonce,
      ...(opts.again && { max_age: '0' }),
    }).toString();
    res.redirect(303, url.pathname + url.search);
  }

  /** Where the account client’s sign-in lands next, from its `state`. (Not `then`: Nest would take the service for a promise.) */
  afterSignIn(state: string | undefined): string {
    const ciba = THEN.exec(state ?? '')?.[1];
    return ciba ? `/ciba/${ciba}` : '/account';
  }

  csrf(sessionId: string): string {
    return createHmac('sha256', deriveKey(this.config.LANDBRIGHT_SECRET_KEY, 'account-csrf'))
      .update(sessionId)
      .digest('base64url');
  }

  csrfMatches(sessionId: string, token: string | undefined): boolean {
    const expected = Buffer.from(this.csrf(sessionId));
    const given = Buffer.from(String(token ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
