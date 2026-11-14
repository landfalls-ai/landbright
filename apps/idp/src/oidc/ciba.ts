import type { Config } from '@landbright/platform';
import { appendAudit, type PrismaClient, type TenantRef, withTenant } from '@landbright/persistence';
import { errors, type Configuration } from 'oidc-provider';
import { agentOf, whyAgentMayNotActFor } from './agents';

type CibaFeature = NonNullable<NonNullable<Configuration['features']>['ciba']>;

/** Where the person decides: a Landbright page, signed in (apps/idp/src/ciba). */
export const cibaLink = (config: Pick<Config, 'LANDBRIGHT_IDP_URL'>, id: string) =>
  new URL(`/ciba/${encodeURIComponent(id)}`, config.LANDBRIGHT_IDP_URL).href;

/**
 * OpenID CIBA, poll mode, with Landflow as the channel: an agent's application names a person (`login_hint`: their
 * email), the person is told by a Landflow flow, which takes `ciba.requested` from the event stream (the link to the
 * decision page is in it), and the person approves or denies on Landbright's page, signed in. Landbright never decides
 * for them, and the flow can't either: it only carries the link. Only agents' applications ask, and only for people
 * their `actFor` allows.
 */
export function cibaFeature(config: Config, prisma: PrismaClient, tenant: TenantRef): CibaFeature {
  return {
    enabled: true,
    deliveryModes: ['poll'],
    processLoginHint: async (ctx, loginHint) => {
      const agent = agentOf(ctx.oidc.client);
      if (!agent) throw new errors.UnauthorizedClient('only an agent’s application asks a person this way');
      const email = String(loginHint ?? '')
        .trim()
        .toLowerCase();
      const person = await withTenant(prisma, tenant.id, (tx) =>
        tx.identity.findFirst({ where: { email, kind: 'person', status: 'active' }, select: { id: true } }),
      );
      if (!person) return undefined; // unknown_user_id
      const whyNot = whyAgentMayNotActFor(agent, person.id);
      if (whyNot) throw new errors.AccessDenied(whyNot);
      return person.id;
    },
    processLoginHintToken: async () => {
      throw new errors.InvalidRequest('login_hint_token isn’t supported: use login_hint (the person’s email)');
    },
    // No user code: the person signs in to Landbright to decide.
    verifyUserCode: async () => undefined,
    validateRequestContext: async () => undefined,
    triggerAuthenticationDevice: async (ctx, request, account, client) => {
      const agent = agentOf(client)!;
      const person = await withTenant(prisma, tenant.id, (tx) =>
        tx.identity.findUnique({ where: { id: account.accountId }, select: { email: true, displayName: true } }),
      );
      await withTenant(prisma, tenant.id, (tx) =>
        appendAudit(tx, tenant.id, {
          actorId: agent.agentId,
          actorLabel: agent.name,
          action: 'ciba.requested',
          targetType: 'identity',
          targetId: account.accountId,
          data: {
            requestId: request.jti,
            clientId: client.clientId,
            agentId: agent.agentId,
            agent: agent.name,
            person: { id: account.accountId, email: person?.email ?? null, name: person?.displayName ?? null },
            scope: request.scope,
            bindingMessage: (ctx.oidc.params?.binding_message as string | undefined) ?? null,
            link: cibaLink(config, request.jti),
            // `exp` isn't set until the request is read back; `expiration` is its lifetime in seconds.
            expiresAt: new Date(Date.now() + request.expiration * 1000).toISOString(),
          },
        }),
      );
    },
  };
}
