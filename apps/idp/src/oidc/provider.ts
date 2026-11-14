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
import { actClaim, agentOf, whyAgentMayNotActFor } from './agents';
import { cibaFeature } from './ciba';
import { exchangedAct, registerTokenExchange } from './token-exchange';
import { deviceConfirmPage, deviceDonePage, deviceFormParts, deviceInputPage } from '../pages/agent-pages';

/**
 * The OIDC provider (panva/oidc-provider, OpenID Certified), mounted at /oidc on the identity plane. Authorization
 * code with PKCE (required for every client, as OAuth 2.1 does), refresh tokens, client credentials, introspection,
 * revocation, RP-initiated logout; for agents, private_key_jwt, token exchange, CIBA and the device grant; PAR and
 * DPoP. Sign-in happens on Landbright's own pages (/interaction/:uid).
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
    // An agent's application (spec 005, slice 3) also carries its agent: who, how long its tokens live, whom it may act
    // for, and its sponsor (oidc/adapter.ts).
    extraClientMetadata: {
      properties: [
        'api_scopes',
        'minimum_acr',
        'agent_id',
        'agent_name',
        'agent_ttl',
        'agent_act_for',
        'agent_sponsor_id',
      ],
    },
    // A token an agent holds for a person says so: `act` names the agent (RFC 8693 §4.1), and after a token exchange,
    // whoever acted before it.
    extraTokenClaims: (_ctx, token) => {
      const exchanged = exchangedAct.get(token);
      if (exchanged) return { act: exchanged };
      const agent = agentOf(token.client);
      const accountId = (token as { accountId?: string }).accountId;
      return agent && accountId ? { act: actClaim(agent, token.clientId!) } : undefined;
    },
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
            accessTokenTTL: Math.min(600, agentOf(client)?.ttl ?? 600),
            accessTokenFormat: 'jwt',
            jwt: { sign: { alg: 'RS256' } },
          };
        },
      },
      // OpenID CIBA (poll): an agent asks a person, Landflow tells them, they decide on Landbright's page.
      ciba: cibaFeature(config, prisma, tenant),
      // RFC 8628: a command-line agent shows a code; the person enters it at /oidc/device and signs in.
      deviceFlow: {
        enabled: true,
        charset: 'base-20',
        mask: '****-****',
        userCodeInputSource: (ctx, form, out, err) => {
          ctx.type = 'html';
          ctx.body = deviceInputPage({
            ...deviceFormParts(form),
            error: !err
              ? undefined
              : err.name === 'NoCodeError' || (err as { userCode?: string }).userCode
                ? 'That code isn’t right, or it expired. Check the device and try again.'
                : deniedBecause(err)
                  ? `Not connected: ${deniedBecause(err)}`
                  : out?.error === 'access_denied'
                    ? String(out.error_description ?? 'Access was denied.')
                    : 'The device sign-in was interrupted. Start again on the device.',
          });
        },
        userCodeConfirmSource: (ctx, form, client, _deviceInfo, userCode) => {
          ctx.type = 'html';
          ctx.body = deviceConfirmPage({
            ...deviceFormParts(form),
            userCode,
            clientName: client.clientName ?? client.clientId,
            agent: agentOf(client)?.name,
          });
        },
        successSource: (ctx) => {
          ctx.type = 'html';
          ctx.body = deviceDonePage(ctx.oidc.client?.clientName ?? 'The device');
        },
      },
      // PAR (RFC 9126) and DPoP (RFC 9449) are oidc-provider's defaults (on); listed here so the choice is visible.
      pushedAuthorizationRequests: { enabled: true, requirePushedAuthorizationRequests: false },
      dPoP: { enabled: true },
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
      // An agent's application signing a person in (the device grant): only someone the agent may act for.
      const agent = agentOf(client);
      const whyNot = agent && whyAgentMayNotActFor(agent, session.accountId);
      if (whyNot) throw new errors.AccessDenied(whyNot);
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
      AccessToken: (ctx, token, client) =>
        token.resourceServer?.accessTokenTTL ?? Math.min(capToGrant(ctx, 3600), agentOf(client)?.ttl ?? 3600),
      AuthorizationCode: 60,
      ClientCredentials: (_ctx, _token, client) => Math.min(600, agentOf(client)?.ttl ?? 600),
      BackchannelAuthenticationRequest: 600,
      DeviceCode: 600,
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
  registerTokenExchange(provider, { prisma, tenant, keys });
  return provider;
}

/** Why a device sign-in was refused (oidc-provider wraps the AccessDenied in an AbortedError), if it was. */
function deniedBecause(err: Error): string | undefined {
  const cause = (err as { cause?: { error?: string; error_description?: string } }).cause;
  return err.name === 'AbortedError' && cause?.error === 'access_denied' ? cause.error_description : undefined;
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
