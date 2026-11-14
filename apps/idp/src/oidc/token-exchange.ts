import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from '@landbright/contracts';
import { MACHINE_API_RESOURCE } from '@landbright/platform';
import { appendAudit, type PrismaClient, type SigningJwk, type TenantRef, withTenant } from '@landbright/persistence';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type Provider from 'oidc-provider';
import { errors, type KoaContextWithOIDC } from 'oidc-provider';
import { loadAccount } from './account';
import { actClaim, agentOf, whyAgentMayNotActFor } from './agents';

/** The `act` claim of each exchanged token, read back by `extraTokenClaims` when the token is signed. */
export const exchangedAct = new WeakMap<object, Record<string, unknown>>();

/** invalid_grant with the reason as its description (oidc-provider's own description is fixed). */
const invalidGrant = (reason: string) => Object.assign(new errors.InvalidGrant(reason), { error_description: reason });

/** Scopes an exchanged token for another application may carry: what the person's token had, never a refresh. */
const NOT_EXCHANGED = new Set(['offline_access']);

interface Subject {
  sub: string;
  scope: string;
  exp: number;
  act?: Record<string, unknown>;
}

/**
 * RFC 8693 token exchange, for agents' applications only: an agent trades a person's access token (one Landbright
 * issued: opaque from a sign-in, CIBA or the device grant, or a JWT from an earlier exchange) for a JWT at another
 * audience that says the agent acts for them (`act`: the agent, then any earlier actor). The machine API is the
 * default audience (scopes: what the application holds); another application's client id may be the `audience`
 * (scopes: what the person's token had). The agent must be allowed to act for the person (its `actFor`), the person
 * must be active, and the new token ends no later than the person's token or the agent's `maxTokenTtlSeconds`.
 * oidc-provider has no token exchange of its own, so this is a grant registered on it.
 */
export function registerTokenExchange(
  provider: Provider,
  deps: { prisma: PrismaClient; tenant: TenantRef; keys: SigningJwk[] },
): void {
  const jwks = createLocalJWKSet({
    keys: deps.keys.map(({ kty, n, e, kid, alg }) => ({ kty, n, e, kid, alg, use: 'sig' })),
  });

  async function subjectOf(token: string): Promise<Subject> {
    if (token.split('.').length === 3) {
      const { payload } = await jwtVerify(token, jwks, { issuer: provider.issuer }).catch(() => {
        throw invalidGrant('subject_token is not a valid Landbright token');
      });
      if (!payload.sub || payload.sub === payload.client_id || (payload.cnf as object | undefined))
        throw invalidGrant('subject_token is not a person’s unbound access token');
      return {
        sub: payload.sub,
        scope: String(payload.scope ?? ''),
        exp: Number(payload.exp),
        act: payload.act as Record<string, unknown> | undefined,
      };
    }
    const at = await provider.AccessToken.find(token);
    if (!at?.accountId || at.isExpired) throw invalidGrant('subject_token is invalid or expired');
    if (at.isSenderConstrained()) throw invalidGrant('a sender-constrained subject_token can’t be exchanged');
    return {
      sub: at.accountId,
      scope: at.scope ?? '',
      exp: at.exp ?? 0,
      act: (at.extra as { act?: Record<string, unknown> } | undefined)?.act,
    };
  }

  provider.registerGrantType(
    TOKEN_EXCHANGE_GRANT,
    async (ctx: KoaContextWithOIDC) => {
      const client = ctx.oidc.client!;
      const agent = agentOf(client);
      if (!agent) throw new errors.UnauthorizedClient('only an agent’s application exchanges tokens');
      const params = ctx.oidc.params as Record<string, string | string[] | undefined>;
      if (params.subject_token_type !== ACCESS_TOKEN_TYPE)
        throw new errors.InvalidRequest(`subject_token_type must be ${ACCESS_TOKEN_TYPE}`);
      if (params.requested_token_type && params.requested_token_type !== ACCESS_TOKEN_TYPE)
        throw new errors.InvalidRequest(`requested_token_type must be ${ACCESS_TOKEN_TYPE}`);
      if (params.actor_token) throw new errors.InvalidRequest('the agent is the actor: actor_token isn’t used');
      if (!params.subject_token) throw new errors.InvalidRequest('subject_token is missing');

      const subject = await subjectOf(String(params.subject_token));
      const person = await loadAccount(deps.prisma, deps.tenant, subject.sub);
      if (!person) throw invalidGrant('the person isn’t active');
      const whyNot = whyAgentMayNotActFor(agent, subject.sub);
      if (whyNot) throw invalidGrant(whyNot);

      const asked = String(params.scope ?? '')
        .split(' ')
        .filter(Boolean);
      const audiences = [params.audience, params.resource].flat().filter((v): v is string => Boolean(v));
      if (audiences.length > 1) throw new errors.InvalidTarget('ask for one audience');
      const audience = audiences[0] ?? MACHINE_API_RESOURCE;
      let scopes: string[];
      if (audience === MACHINE_API_RESOURCE) {
        const held = (client['api_scopes'] as string[] | undefined) ?? [];
        scopes = asked.length ? asked.filter((s) => held.includes(s)) : held;
      } else {
        const target = await provider.Client.find(audience);
        if (!target || target.clientId === client.clientId) throw new errors.InvalidTarget('unknown audience');
        const had = subject.scope.split(' ').filter((s) => s && !NOT_EXCHANGED.has(s));
        scopes = asked.length ? asked.filter((s) => had.includes(s)) : had;
      }
      if (scopes.length === 0)
        throw new errors.InvalidScope('none of the requested scopes can be granted', asked.join(' '));

      const now = Math.floor(Date.now() / 1000);
      const ttl = Math.min(agent.ttl, subject.exp - now, 3600);
      if (ttl < 30) throw invalidGrant('subject_token expires too soon to exchange');

      // A grant of its own (the agent, for this person), so revoking the person's grants revokes it too.
      const grant = new provider.Grant({ accountId: subject.sub, clientId: client.clientId });
      if (audience === MACHINE_API_RESOURCE) grant.addResourceScope(audience, scopes.join(' '));
      else grant.addOIDCScope(scopes.join(' '));
      const grantId = await grant.save();
      const at = new provider.AccessToken({
        accountId: subject.sub,
        client,
        grantId,
        scope: scopes.join(' '),
        gty: 'token_exchange',
      });
      at.resourceServer = {
        audience,
        scope: scopes.join(' '),
        accessTokenTTL: ttl,
        accessTokenFormat: 'jwt',
        jwt: { sign: { alg: 'RS256' } },
      } as never;
      const act = actClaim(agent, client.clientId, subject.act);
      exchangedAct.set(at, act);
      const value = await at.save();

      await withTenant(deps.prisma, deps.tenant.id, (tx) =>
        appendAudit(tx, deps.tenant.id, {
          actorId: agent.agentId,
          actorLabel: agent.name,
          action: 'token.exchanged',
          targetType: 'identity',
          targetId: subject.sub,
          data: { clientId: client.clientId, agentId: agent.agentId, audience, scope: scopes.join(' '), act, ttl },
        }),
      );
      ctx.body = {
        access_token: value,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: ttl,
        scope: scopes.join(' '),
      };
    },
    [
      'subject_token',
      'subject_token_type',
      'requested_token_type',
      'audience',
      'resource',
      'scope',
      'actor_token',
      'actor_token_type',
    ],
    ['audience', 'resource'],
  );
}
