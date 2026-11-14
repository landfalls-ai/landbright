import { z } from 'zod';

/**
 * Events out (spec 004), Landbright's answer to Keycloak's event listeners: every audit event whose action matches a
 * subscription is delivered to it (a Landflow Webhook trigger), signed as a JWT with Landbright's own key, with an
 * `Idempotency-Key`. docs/events.md lists the event types and the delivery format.
 */

const Pattern = z
  .string()
  .trim()
  .regex(/^(\*|[a-z_]+(\.[a-z_]*)?\*?)$/, 'An event type (request.created) or a prefix (grant.*, group.member_*)');

export const Subscription = z.object({
  id: z.uuid(),
  url: z.string(),
  events: z.array(z.string()),
  description: z.string().nullable(),
  audience: z.string(),
  disabled: z.boolean(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  stats: z.object({ pending: z.number().int(), delivered: z.number().int(), failed: z.number().int() }),
});
export type Subscription = z.infer<typeof Subscription>;
export const SubscriptionList = z.object({ items: z.array(Subscription), eventTypes: z.array(z.string()) });

export const CreateSubscription = z.object({
  url: z.url({ protocol: /^https?$/ }),
  events: z.array(Pattern).min(1).max(30),
  description: z.string().trim().max(300).optional(),
  /** The `aud` claim; Landflow's JWT Auth credential can require it. Defaults to the URL's origin. */
  audience: z.string().trim().min(1).max(300).optional(),
  /** Deliver events from now on (default), or also the last N audit events (useful to test a new flow). */
  replay: z.number().int().min(0).max(100).default(0),
});
export type CreateSubscription = z.infer<typeof CreateSubscription>;
export const UpdateSubscription = z.object({
  events: z.array(Pattern).min(1).max(30).optional(),
  description: z.string().trim().max(300).optional(),
  disabled: z.boolean().optional(),
});

export const Delivery = z.object({
  id: z.uuid(),
  subscriptionId: z.uuid(),
  auditEventId: z.string(),
  action: z.string(),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number().int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  response: z.unknown().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Delivery = z.infer<typeof Delivery>;
export const DeliveryList = z.object({ items: z.array(Delivery) });

/** The JWT's claims (RFC 8417 Security Event Token shape, plus `type` and `event` for flows to read directly). */
export const DeliveredEvent = z.object({
  id: z.string(),
  type: z.string(),
  at: z.iso.datetime(),
  actor: z.object({ id: z.string().nullable(), label: z.string() }),
  target: z.object({ type: z.string(), id: z.string().nullable() }),
  data: z.record(z.string(), z.unknown()),
});
export type DeliveredEvent = z.infer<typeof DeliveredEvent>;
