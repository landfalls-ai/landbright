import { deriveKey, issuerOf, type Config } from '@landbright/platform';
import type { PrismaClient, SigningJwk, TenantRef } from '@landbright/persistence';
import Provider, { type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { errorPage, logoutPage, signedOutPage } from '../pages/pages';
import { CLAIMS, loadAccount } from './account';
import { postgresAdapter } from './adapter';

/**
 * The OIDC provider (panva/oidc-provider, OpenID Certified), mounted at /oidc on the identity plane. Authorization
 * code with PKCE (required for every client, as OAuth 2.1 does), refresh tokens, client credentials, introspection,
 * revocation, RP-initiated logout. Sign-in happens on Landbright's own pages (/interaction/:uid).
 */
export function createProvider(config: Config, prisma: PrismaClient, tenant: TenantRef, keys: SigningJwk[]): Provider {
  const secret = config.LANDBRIGHT_SECRET_KEY;
  const pkceOptional = new Set(config.LANDBRIGHT_PKCE_OPTIONAL_CLIENTS);
  const configuration: Configuration = {
    adapter: postgresAdapter(prisma, tenant, secret),
    findAccount: (_ctx, sub) => loadAccount(prisma, tenant, sub),
    jwks: { keys },
    cookies: { keys: [deriveKey(secret, 'oidc-cookies').toString('base64url')] },
    claims: CLAIMS,
    scopes: ['openid', 'offline_access', 'email', 'profile', 'roles'],
    // Put the scope's claims in the ID token too: relying parties such as Landflow read email and roles from it.
    conformIdTokenClaims: false,
    // PKCE for every client (OAuth 2.1), except client ids the conformance run names (LANDBRIGHT_PKCE_OPTIONAL_CLIENTS).
    pkce: { required: (_ctx, client) => !pkceOptional.has(client.clientId) },
    responseTypes: ['code'],
    features: {
      devInteractions: { enabled: false },
      clientCredentials: { enabled: true },
      introspection: { enabled: true },
      revocation: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: (ctx, form) => {
          ctx.type = 'html';
          ctx.body = logoutPage(form, ctx.oidc.client?.clientName);
        },
        postLogoutSuccessSource: (ctx) => {
          ctx.type = 'html';
          ctx.body = signedOutPage(ctx.oidc.client?.clientName);
        },
      },
    },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    // Every application is registered by an administrator, so there is no consent screen: the grant covers what the
    // application asked for. (Agents and third-party apps get policy-based consent in wave 5.)
    loadExistingGrant: async (ctx: KoaContextWithOIDC) => {
      const session = ctx.oidc.session;
      const client = ctx.oidc.client;
      if (!session?.accountId || !client) return undefined;
      const grantId = ctx.oidc.result?.consent?.grantId ?? session.grantIdFor(client.clientId);
      const scope = String(ctx.oidc.params?.scope ?? 'openid');
      const existing = grantId ? await ctx.oidc.provider.Grant.find(grantId) : undefined;
      // An app asking for more scopes than its last sign-in (say, adding `roles`) gets them on the same grant.
      const grant =
        existing ?? new ctx.oidc.provider.Grant({ clientId: client.clientId, accountId: session.accountId });
      grant.addOIDCScope(scope);
      await grant.save();
      return grant;
    },
    ttl: {
      AccessToken: 3600,
      AuthorizationCode: 60,
      ClientCredentials: 600,
      // A key rotation keeps the replaced key published at least this long (rotateAfter in @landbright/persistence).
      IdToken: config.LANDBRIGHT_ID_TOKEN_TTL_SECONDS,
      Interaction: 3600,
      Session: 8 * 3600,
      Grant: 14 * 24 * 3600,
      RefreshToken: 14 * 24 * 3600,
    },
    renderError: (ctx, out) => {
      ctx.type = 'html';
      ctx.body = errorPage(String(out.error_description ?? out.error));
    },
  };
  const provider = new Provider(issuerOf(config), configuration);
  // Behind a TLS proxy, trust X-Forwarded-Proto so cookies are secure and URLs say https.
  provider.proxy = config.LANDBRIGHT_TRUST_PROXY;
  return provider;
}
