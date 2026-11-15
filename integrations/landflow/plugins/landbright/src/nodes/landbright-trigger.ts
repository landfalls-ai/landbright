import {
  defineNode,
  NodeOperationError,
  type IWebhookContext,
  type IWebhookMethodContext,
  type JsonObject,
} from '@landflow/sdk';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { call, LandbrightError, type ApiContext, type LandbrightCredentials } from '../client';
import { COLOR } from './landbright';

/**
 * The Landbright Trigger (spec 007): Landbright's events start the workflow. Publishing subscribes the node's URL
 * through the machine API (`events:manage`); unpublishing removes the subscription. Every delivery is a Security
 * Event Token signed by Landbright: checked against `{issuer}/jwks`, so no secret is shared, and the item is the
 * event inside the token, not the body.
 */

interface TriggerStatic extends JsonObject {
  subscriptionId: string;
  url: string;
  events: string[];
  audience: string;
}

export const DEFAULT_EVENTS = 'identity.*';

/** Event patterns from the Events parameter: comma, space or newline separated (`identity.*`, `grant.revoked`, `*`). */
export function patternsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,]+/);
  return [...new Set(list.map((p) => p.trim()).filter(Boolean))];
}

/** Landbright's own rule: exact, a prefix ending in `*`, or `*`. */
export const matches = (patterns: string[], type: string) =>
  patterns.some((p) => p === type || (p.endsWith('*') && type.startsWith(p.slice(0, -1))));

const trim = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/\/+$/, '');

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
/** The issuer's keys, fetched once and again for a `kid` not seen (a rotation), at most every 30 seconds. */
function keysOf(issuer: string) {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

const credentialsOf = (ctx: IWebhookContext | IWebhookMethodContext) =>
  ctx.getCredentials<LandbrightCredentials>('landbrightApi');
const apiOf = (ctx: IWebhookContext | IWebhookMethodContext): ApiContext => ({ http: ctx.http });

const sameEvents = (a: unknown, b: string[]) =>
  Array.isArray(a) && JSON.stringify([...a].map(String).sort()) === JSON.stringify([...b].sort());

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const LandbrightTrigger = defineNode({
  description: {
    name: 'landbrightTrigger',
    displayName: 'Landbright Trigger',
    description:
      'Starts the workflow on Landbright events (a person created, updated or deactivated, a grant, a request…); subscribes itself when published',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['HR', 'Development'],
    icon: 'file:landbright-trigger.svg',
    color: COLOR,
    subtitle: '{{events}}',
    keywords: ['landbright', 'identity', 'event', 'joiner', 'mover', 'leaver', 'grant', 'request', 'webhook'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'landbrightApi', required: true }],
    properties: [
      {
        name: 'notice',
        displayName:
          "Publishing subscribes this node's URL in Landbright (the credential's application needs events:manage, and Landflow's address among its redirect URIs); unpublishing removes it. Each delivery's token is checked against Landbright's JWKS.",
        type: 'notice',
        default: '',
      },
      {
        name: 'events',
        displayName: 'Events',
        type: 'string',
        default: DEFAULT_EVENTS,
        required: true,
        placeholder: 'identity.deactivated, grant.*',
        description:
          'Event types or prefixes ending in *, comma-separated (identity.created, identity.*, grant.revoked, *). Landbright → Events lists them',
      },
    ],
  },
  execute(ctx) {
    ctx.logger.info('Landbright sends events to the published workflow; a manual run has no event to output');
    return [];
  },
  webhookMethods: {
    async checkExists(ctx) {
      const data = ctx.getStaticData<TriggerStatic>();
      if (!data.subscriptionId || data.url !== ctx.getWebhookUrl()) return false;
      if (!sameEvents(data.events, patternsOf(ctx.getNodeParameter('events', DEFAULT_EVENTS)))) return false;
      const { items } = await call(apiOf(ctx), credentialsOf(ctx), 'GET', '/subscriptions');
      return ((items ?? []) as JsonObject[]).some(
        (s) => s.id === data.subscriptionId && s.url === data.url && sameEvents(s.events, data.events),
      );
    },
    async create(ctx) {
      const events = patternsOf(ctx.getNodeParameter('events', DEFAULT_EVENTS));
      if (!events.length) throw new NodeOperationError('Name at least one event (identity.*, for one)');
      const data = ctx.getStaticData() as Partial<TriggerStatic>;
      const credentials = credentialsOf(ctx);
      // A subscription left from an earlier publish (other events) is replaced, not kept beside the new one.
      if (data.subscriptionId) await remove(ctx, credentials, data.subscriptionId);
      const url = ctx.getWebhookUrl();
      const audience = new URL(url).origin;
      const subscription = await call(apiOf(ctx), credentials, 'POST', '/subscriptions', {
        url,
        events,
        audience,
        description: `Landflow workflow ${ctx.getWorkflowId()}, node ${ctx.getNode().name}`,
      });
      ctx.setStaticData({ subscriptionId: String(subscription.id), url, events, audience } satisfies TriggerStatic);
      ctx.logger.info('Landbright Trigger subscribed', { subscription: String(subscription.id), events });
      return true;
    },
    async delete(ctx) {
      const data = ctx.getStaticData() as Partial<TriggerStatic>;
      if (data.subscriptionId) await remove(ctx, credentialsOf(ctx), data.subscriptionId);
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const answer = (status: number, json: JsonObject) => ({ response: { status, json } });
    const bearer = /^Bearer\s+(\S+)$/i.exec(ctx.getHeader('authorization') ?? '')?.[1];
    if (!bearer) return answer(401, { error: 'a Landbright event token is required' });
    const credentials = credentialsOf(ctx);
    const issuer = trim(credentials.issuer);
    const data = ctx.getStaticData() as Partial<TriggerStatic>;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(bearer, keysOf(issuer), {
        issuer,
        audience: data.audience || new URL(ctx.getWebhookUrl()).origin,
        algorithms: ['RS256'],
        typ: 'secevent+jwt',
        requiredClaims: ['jti', 'iat', 'exp'],
      }));
    } catch (error) {
      ctx.logger.warn(`rejected a delivery: ${(error as Error).message}`);
      return answer(401, { error: 'invalid token' });
    }
    const event = payload.event;
    if (!isObject(event) || typeof event.type !== 'string') return answer(400, { error: 'the token carries no event' });
    // An administrator may have widened the subscription in Landbright: the node's events still decide.
    const events = data.events?.length ? data.events : patternsOf(ctx.getNodeParameter('events', DEFAULT_EVENTS));
    if (!matches(events, event.type)) return answer(200, { ignored: event.type });
    // Landbright retries until it gets a 2xx: the event's id starts one run, however often it comes.
    return {
      items: [{ json: event }],
      response: { status: 200, json: { received: String(payload.jti) } },
      idempotencyKey: String(payload.jti),
    };
  },
});

/** Removes a subscription; one already gone (removed in the console) is fine. */
async function remove(ctx: IWebhookMethodContext, credentials: LandbrightCredentials, id: string) {
  try {
    await call(apiOf(ctx), credentials, 'DELETE', `/subscriptions/${encodeURIComponent(id)}`);
  } catch (error) {
    if (!(error instanceof LandbrightError && error.status === 404)) throw error;
  }
}
