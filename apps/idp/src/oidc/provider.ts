import { deriveKey, issuerOf, MACHINE_API_RESOURCE, type Config } from '@landbright/platform';
import type { PrismaClient, SigningJwk, TenantRef } from '@landbright/persistence';
import Provider, {
  errors,
  interactionPolicy,
  type ClientMetadata,
  type Configuration,
  type KoaContextWithOIDC,
  type ResponseType,
} from 'oidc-provider';
import { ACR_VALUES, acrLevel, neededAcr } from '@landbright/contracts';
import { errorPage, logoutPage, signedOutPage } from '../pages/pages';
import { capToGrant, CLAIMS, loadAccount } from './account';
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
    // `none`: only the account page's own client uses it (sign in, come back, no tokens).
    responseTypes: ['code', 'none'],
    // What an application may do as itself on the machine API (client credentials), from its `apiScopes`; the weakest
    // sign-in it accepts, from its `minimumAcr`.
    extraClientMetadata: { properties: ['api_scopes', 'minimum_acr'] },
    // How strongly someone signed in: urn:landbright:acr:pwd, :mfa, :phr (libs/contracts/src/acr.ts).
    acrValues: [...ACR_VALUES],
    // The account page (/account) signs people in through this client: a session, and no tokens.
    clients: [accountClient(config)],
    features: {
      devInteractions: { enabled: false },
      clientCredentials: { enabled: true },
      // Client credentials for the machine API (/api/v1 on the control plane): a JWT access token whose audience is
      // MACHINE_API_RESOURCE and whose scopes are what the application was granted. Sign-in flows are unaffected (no
      // resource: opaque tokens for userinfo, as before).
      resourceIndicators: {
        enabled: true,
        defaultResource: (ctx) =>
          ctx.oidc.params?.grant_type === 'client_credentials'
            ? MACHINE_API_RESOURCE
            : (undefined as unknown as string),
        useGrantedResource: () => false,
        getResourceServerInfo: (_ctx, resource, client) => {
          if (resource !== MACHINE_API_RESOURCE) throw new errors.InvalidTarget('unknown resource');
          const scopes = (client.api_scopes as string[] | undefined) ?? [];
          if (scopes.length === 0) throw new errors.InvalidTarget('this application has no machine API access');
          return {
            scope: scopes.join(' '),
            audience: MACHINE_API_RESOURCE,
            accessTokenTTL: 600,
            accessTokenFormat: 'jwt',
            jwt: { sign: { alg: 'RS256' } },
          };
        },
      },
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
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}`, policy: signInPolicy() },
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
      // Sign-in tokens end with the soonest just-in-time membership in their claims (capToGrant); machine API tokens
      // keep their resource server's lifetime.
      AccessToken: (ctx, token) => token.resourceServer?.accessTokenTTL ?? capToGrant(ctx, 3600),
      AuthorizationCode: 60,
      ClientCredentials: 600,
      // A key rotation keeps the replaced key published at least this long (rotateAfter in @landbright/persistence).
      IdToken: (ctx) => capToGrant(ctx, config.LANDBRIGHT_ID_TOKEN_TTL_SECONDS),
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

/** The account page's client: Landbright's own, static, no secret and no tokens (response type `none`). */
export const ACCOUNT_CLIENT_ID = 'landbright-account';
export const accountRedirectUri = (config: Pick<Config, 'LANDBRIGHT_IDP_URL'>) =>
  new URL('/account/signed-in', config.LANDBRIGHT_IDP_URL).href;

function accountClient(config: Config): ClientMetadata {
  return {
    client_id: ACCOUNT_CLIENT_ID,
    client_name: 'Your Landbright account',
    token_endpoint_auth_method: 'none' as const,
    grant_types: [],
    response_types: ['none'] as ResponseType[],
    redirect_uris: [accountRedirectUri(config)],
    post_logout_redirect_uris: [new URL('/account', config.LANDBRIGHT_IDP_URL).href],
  };
}

/**
 * oidc-provider's prompts, plus step-up: someone already signed in more weakly than the application's minimum (or
 * than the request's `acr_values`) signs in again, more strongly (the interaction knows what is needed from the
 * same two inputs).
 */
function signInPolicy() {
  const policy = interactionPolicy.base();
  policy.get('login')!.checks.add(
    new interactionPolicy.Check('acr_too_low', 'the application needs a stronger sign-in', (ctx) => {
      const needed = neededAcr(
        ctx.oidc.client?.['minimum_acr'] as string | undefined,
        ctx.oidc.params?.acr_values as string | undefined,
      );
      if (!needed || acrLevel(ctx.oidc.acr) >= acrLevel(needed)) return interactionPolicy.Check.NO_NEED_TO_PROMPT;
      return interactionPolicy.Check.REQUEST_PROMPT;
    }),
  );
  return policy;
}
