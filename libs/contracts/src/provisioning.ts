import { z } from 'zod';
import { patchOf } from './patch';

/**
 * Provisioning out (spec 006): Landbright as the SCIM 2.0 client of an application (Landflow, Landfall, Clickland).
 * The people in the assigned groups are pushed, and, in `groups` mode, the groups with their members.
 * docs/provisioning.md.
 */

export const GROUPS_MODES = ['groups', 'user_attribute'] as const;
export type GroupsMode = (typeof GROUPS_MODES)[number];

export const ScimTargetState = z.enum(['in_sync', 'pushing', 'failing', 'disabled']);
export type ScimTargetState = z.infer<typeof ScimTargetState>;

export const ScimTarget = z.object({
  id: z.uuid(),
  name: z.string(),
  baseUrl: z.string(),
  groupsMode: z.enum(GROUPS_MODES),
  groups: z.array(z.object({ id: z.uuid(), name: z.string() })),
  application: z.object({ id: z.uuid(), clientId: z.string(), name: z.string() }).nullable(),
  disabled: z.boolean(),
  state: ScimTargetState,
  /** People pushed and active there, people pushed and inactive, groups pushed. */
  counts: z.object({ active: z.number().int(), inactive: z.number().int(), groups: z.number().int() }),
  queued: z.number().int(),
  failing: z.number().int(),
  /** The newest error of a failing push. */
  lastError: z.string().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastReconciledAt: z.iso.datetime().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});
export type ScimTarget = z.infer<typeof ScimTarget>;
export const ScimTargetList = z.object({ items: z.array(ScimTarget) });

export const ScimLinkView = z.object({
  kind: z.enum(['user', 'group']),
  localId: z.uuid(),
  /** The person's or group's name in Landbright (null when the group was deleted). */
  name: z.string().nullable(),
  email: z.string().nullable(),
  remoteId: z.string(),
  active: z.boolean().nullable(),
  members: z.number().int().nullable(),
  syncedAt: z.iso.datetime(),
});
export type ScimLinkView = z.infer<typeof ScimLinkView>;

export const ScimJobView = z.object({
  kind: z.enum(['user', 'group']),
  localId: z.uuid(),
  name: z.string().nullable(),
  verify: z.boolean(),
  attempts: z.number().int(),
  nextAttemptAt: z.iso.datetime(),
  lastError: z.string().nullable(),
  queuedAt: z.iso.datetime(),
});
export type ScimJobView = z.infer<typeof ScimJobView>;

export const ScimTargetDetail = ScimTarget.extend({
  links: z.array(ScimLinkView),
  jobs: z.array(ScimJobView),
});
export type ScimTargetDetail = z.infer<typeof ScimTargetDetail>;

const BaseUrl = z
  .url({ protocol: /^https?$/ })
  .transform((u) => u.replace(/\/+$/, ''))
  .refine((u) => !/\/(Users|Groups)$/.test(u), 'The SCIM base, without /Users or /Groups at the end.');

export const CreateScimTarget = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: BaseUrl,
  /** The bearer token the application issued for Landbright. Stored encrypted; never shown again. */
  token: z.string().trim().min(8).max(4000),
  groupsMode: z.enum(GROUPS_MODES).default('groups'),
  groupIds: z.array(z.uuid()).max(200).default([]),
  /** The OIDC application (its row id) this server belongs to. */
  applicationId: z.uuid().nullable().optional(),
  disabled: z.boolean().default(false),
});
export type CreateScimTarget = z.infer<typeof CreateScimTarget>;
const { token: _token, ...updatable } = CreateScimTarget.shape;
export const UpdateScimTarget = patchOf(z.object(updatable));
export type UpdateScimTarget = z.infer<typeof UpdateScimTarget>;

export const ReplaceScimToken = z.object({ token: z.string().trim().min(8).max(4000) });
export type ReplaceScimToken = z.infer<typeof ReplaceScimToken>;

/** What *Test* found: whether the server answered, and whether it took the token. */
export const ScimTestResult = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  detail: z.string(),
  /** From /ServiceProviderConfig, when the server has one. */
  patch: z.boolean().nullable(),
  filter: z.boolean().nullable(),
});
export type ScimTestResult = z.infer<typeof ScimTestResult>;
