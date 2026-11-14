import { z } from 'zod';

export const AuditEvent = z.object({
  /** Sequence within the tenant, as a string (it is a bigint). */
  id: z.string(),
  at: z.iso.datetime(),
  actorId: z.string().nullable(),
  actorLabel: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  hash: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditPage = z.object({
  items: z.array(AuditEvent),
  /** Pass as `before` to read older events; null at the start of the log. */
  nextBefore: z.string().nullable(),
  /** Whether the events on this page link up and match their hashes. */
  chainIntact: z.boolean(),
});
export type AuditPage = z.infer<typeof AuditPage>;
