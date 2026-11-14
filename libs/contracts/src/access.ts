import { z } from 'zod';
import { patchOf } from './patch';
import { IdentityRef } from './directory';

/**
 * Just-in-time access (spec 004): bundles people ask for, the policy that decides who may ask and who approves,
 * requests, votes and grants. The decision is always Landbright's; Landflow flows run the conversation around it,
 * provision what Landbright doesn't, and report back. docs/access.md explains the rules.
 */

const Minutes = z
  .number()
  .int()
  .positive()
  .max(60 * 24 * 90);
const Ids = z.array(z.uuid()).max(50).default([]);

/** Who approves one step. Everyone named here may vote; `approvalsRequired` distinct people must approve. */
export const ApprovalStep = z.object({
  name: z.string().trim().min(1).max(80).default('Approval'),
  approvers: z
    .object({
      /** Standing members of these groups (a membership a grant gave doesn't count). */
      groupIds: Ids,
      identityIds: Ids,
      /** The subject's manager (from the directory). */
      manager: z.boolean().default(false),
      bundleOwner: z.boolean().default(false),
      /** For an agent's access: the person who sponsors it. */
      sponsor: z.boolean().default(false),
    })
    .default({ groupIds: [], identityIds: [], manager: false, bundleOwner: false, sponsor: false }),
  approvalsRequired: z.number().int().min(1).max(5).default(1),
  /**
   * Whether this step's approvers may also vote from a chat a flow relays (Slack), with a single-use ticket Landbright
   * issued for that approver. Off by default: a vote on Landbright's own decision page is the stronger one.
   */
  allowRelayed: z.boolean().default(false),
});
export type ApprovalStep = z.infer<typeof ApprovalStep>;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

/** Days (0 Sunday … 6 Saturday) and hours, in an IANA time zone. `to` before `from` spans midnight. */
export const TimeWindow = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  from: HHMM.default('09:00'),
  to: HHMM.default('18:00'),
  timeZone: z
    .string()
    .max(60)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'An IANA time zone, such as Asia/Jerusalem')
    .default('UTC'),
});
export type TimeWindow = z.infer<typeof TimeWindow>;

/** Whether `at` falls inside the window. */
export function inWindow(window: TimeWindow, at: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: window.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  const now = Number(part('hour')) * 60 + Number(part('minute'));
  const [fh, fm] = window.from.split(':').map(Number);
  const [th, tm] = window.to.split(':').map(Number);
  const from = fh! * 60 + fm!;
  const to = th! * 60 + tm!;
  if (from === to) return window.days.includes(day);
  if (from < to) return window.days.includes(day) && now >= from && now < to;
  // Spans midnight: the evening part belongs to `day`, the morning part to the day before.
  if (now >= from) return window.days.includes(day);
  return now < to && window.days.includes((day + 6) % 7);
}

/**
 * An auto-approve rule: facts Landbright holds itself. A rule only ever approves; it never denies. Its evidence is kept
 * on the request.
 */
export const AutoApproveRule = z.object({
  name: z.string().trim().min(1).max(80),
  /** The subject is a standing member of one of these groups. */
  subjectInGroupIds: Ids,
  /** And asks for at most this long. */
  maxDurationMinutes: Minutes.optional(),
  /** And asks within these hours (on-call hours, business hours), in the time zone given. */
  window: TimeWindow.optional(),
});
export type AutoApproveRule = z.infer<typeof AutoApproveRule>;

export const AccessPolicy = z.object({
  /** Who may ask: standing members of these groups (empty: every active person). */
  eligibleGroupIds: Ids,
  /** Whether a sponsor may ask for this bundle for one of their agents. */
  agentsAllowed: z.boolean().default(false),
  steps: z
    .array(ApprovalStep)
    .min(1)
    .max(3)
    .default([ApprovalStep.parse({})]),
  /** Used when a step names nobody but the requester. If still nobody, the request is refused when it's made. */
  approverFallback: z.array(z.enum(['bundleOwner', 'admins'])).default(['bundleOwner', 'admins']),
  defaultDurationMinutes: Minutes.default(60),
  maxDurationMinutes: Minutes.default(240),
  /** Agents get less: at most this long, whatever they ask. */
  agentMaxDurationMinutes: Minutes.default(15),
  /** An undecided request expires after this long. */
  decisionDeadlineMinutes: Minutes.default(240),
  /** `grant.expiring` goes out this long before the end. */
  expiringNoticeMinutes: z.number().int().min(1).max(1440).default(15),
  reason: z
    .object({
      mode: z.enum(['required', 'optional']).default('required'),
      prompt: z.string().max(200).default('Why do you need it?'),
      minLength: z.number().int().min(0).max(500).default(10),
    })
    .default({ mode: 'required', prompt: 'Why do you need it?', minLength: 10 }),
  ticket: z
    .object({
      mode: z.enum(['off', 'optional', 'required']).default('off'),
      label: z.string().max(60).default('Ticket'),
      /** A regular expression the ticket id must match, e.g. ^OPS-\d+$ */
      pattern: z.string().max(200).optional(),
      /** One ticket unlocks one request. */
      uniquePerRequest: z.boolean().default(false),
    })
    .default({ mode: 'off', label: 'Ticket', uniquePerRequest: false }),
  autoApprove: z.array(AutoApproveRule).max(10).default([]),
  breakGlass: z
    .object({
      allowed: z.boolean().default(false),
      /** Standing members of these groups may use it. */
      eligibleGroupIds: Ids,
      maxDurationMinutes: Minutes.default(60),
      reviewWithinHours: z.number().int().min(1).max(168).default(24),
    })
    .default({ allowed: false, eligibleGroupIds: [], maxDurationMinutes: 60, reviewWithinHours: 24 }),
  /** Asking for more time on a live grant: the extension is a request of its own, decided by the same steps. */
  extensions: z
    .object({
      allowed: z.boolean().default(true),
      /** How many times one grant can be extended. */
      maxCount: z.number().int().min(0).max(10).default(2),
    })
    .default({ allowed: true, maxCount: 2 }),
  /** After this long without a decision, these groups' people are added to the current step (`request.escalated`). */
  escalation: z
    .object({ afterMinutes: Minutes, toGroupIds: z.array(z.uuid()).min(1).max(10) })
    .nullable()
    .default(null),
});
export type AccessPolicy = z.infer<typeof AccessPolicy>;

/** Something a Landflow flow provisions for a grant (a Landflow project role, a GitHub team…). */
export const BundleTarget = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/, 'Lowercase letters, digits and . _ : - only'),
  type: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(120),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type BundleTarget = z.infer<typeof BundleTarget>;

export const Bundle = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  owner: IdentityRef.nullable(),
  groups: z.array(z.object({ id: z.uuid(), name: z.string() })),
  targets: z.array(BundleTarget),
  policy: AccessPolicy,
  disabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Bundle = z.infer<typeof Bundle>;
export const BundleList = z.object({ items: z.array(Bundle) });

export const CreateBundle = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  ownerId: z.uuid().nullable().optional(),
  groupIds: z.array(z.uuid()).max(20).default([]),
  targets: z.array(BundleTarget).max(20).default([]),
  policy: AccessPolicy.default(AccessPolicy.parse({})),
  disabled: z.boolean().default(false),
});
export type CreateBundle = z.infer<typeof CreateBundle>;
export const UpdateBundle = patchOf(CreateBundle);
export type UpdateBundle = z.infer<typeof UpdateBundle>;

// ---------------------------------------------------------------- requests

export const RequestStatus = z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled', 'superseded']);
export type RequestStatus = z.infer<typeof RequestStatus>;
export const GrantStatus = z.enum(['scheduled', 'active', 'expired', 'revoked']);
export const TargetStatus = z.enum([
  'pending',
  'provisioned',
  'failed',
  'revoked',
  'revoke_failed',
  'verified',
  'drift',
]);
export type TargetStatus = z.infer<typeof TargetStatus>;

export const Ticket = z.object({ id: z.string().trim().min(1).max(120), url: z.url().optional() });

export const CreateRequest = z.object({
  bundleId: z.uuid(),
  /** Yourself (default) or an agent you sponsor. */
  subjectId: z.uuid().optional(),
  durationMinutes: Minutes.optional(),
  reason: z.string().trim().max(1000).optional(),
  ticket: Ticket.optional(),
  /** Start later (at most 7 days ahead). */
  startsAt: z.iso.datetime().optional(),
  /** Grant now and review afterwards, where the policy allows it. */
  breakGlass: z.boolean().default(false),
});
export type CreateRequest = z.infer<typeof CreateRequest>;

export const PreviewRequest = CreateRequest.pick({ bundleId: true, subjectId: true, durationMinutes: true });
export type PreviewRequest = z.infer<typeof PreviewRequest>;

export const RequestPreview = z.object({
  eligible: z.boolean(),
  whyNot: z.string().nullable(),
  /** The rule that would approve it at once, if any. */
  autoApproveRule: z.string().nullable(),
  approvers: z.array(IdentityRef),
  durationMinutes: z.number().int(),
  maxDurationMinutes: z.number().int(),
  reason: AccessPolicy.shape.reason,
  ticket: AccessPolicy.shape.ticket,
  breakGlassAllowed: z.boolean(),
  pendingRequest: z.string().nullable(),
  activeGrantUntil: z.iso.datetime().nullable(),
});
export type RequestPreview = z.infer<typeof RequestPreview>;

export const Vote = z.object({
  decider: IdentityRef,
  step: z.number().int(),
  outcome: z.enum(['approve', 'deny']),
  comment: z.string().nullable(),
  channel: z.string(),
  assurance: z.string(),
  submittedBy: z.string().nullable(),
  at: z.iso.datetime(),
});

export const GrantTargetView = z.object({
  key: z.string(),
  type: z.string(),
  label: z.string(),
  managedBy: z.enum(['landbright', 'flow']),
  status: TargetStatus,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  externalRef: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  updatedAt: z.iso.datetime(),
});

export const GrantView = z.object({
  id: z.uuid(),
  status: GrantStatus,
  startsAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  closingReason: z.string().nullable(),
  isBreakGlass: z.boolean(),
  targets: z.array(GrantTargetView),
});
export type GrantView = z.infer<typeof GrantView>;

export const AccessRequestView = z.object({
  id: z.uuid(),
  number: z.number().int(),
  /** REQ-128 */
  ref: z.string(),
  bundle: z.object({ id: z.uuid(), name: z.string() }),
  requester: IdentityRef,
  subject: IdentityRef,
  actingFor: IdentityRef.nullable(),
  /** For an extension: the grant it adds time to, and the request that grant came from. */
  extends: z.object({ grantId: z.uuid(), ref: z.string() }).nullable(),
  source: z.string(),
  reason: z.string().nullable(),
  ticket: Ticket.nullable(),
  durationMinutes: z.number().int(),
  startsAt: z.iso.datetime().nullable(),
  deadline: z.iso.datetime(),
  status: RequestStatus,
  method: z.string().nullable(),
  closingReason: z.string().nullable(),
  currentStep: z.number().int(),
  steps: z.array(
    z.object({
      name: z.string(),
      approvalsRequired: z.number().int(),
      approvals: z.number().int(),
      approvers: z.array(IdentityRef),
      allowRelayed: z.boolean(),
    }),
  ),
  votes: z.array(Vote),
  /** People named by the current step who haven't voted. */
  waitingOn: z.array(IdentityRef),
  autoApproval: z.unknown().nullable(),
  breakGlass: z.unknown().nullable(),
  grant: GrantView.nullable(),
  /** Where an approver decides: Landbright's decision page. */
  decisionUrl: z.string(),
  /** What the caller may do now. A service never gets `decide`. */
  actions: z.object({ decide: z.boolean(), cancel: z.boolean(), revoke: z.boolean(), extend: z.boolean() }),
  annotations: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export type AccessRequestView = z.infer<typeof AccessRequestView>;
export const AccessRequestList = z.object({ items: z.array(AccessRequestView) });

export const DecideRequest = z.object({
  outcome: z.enum(['approve', 'deny']),
  comment: z.string().trim().max(1000).optional(),
});
export type DecideRequest = z.infer<typeof DecideRequest>;

export const RevokeGrant = z.object({ comment: z.string().trim().max(1000).optional() });

/** More time on a live grant: a request of its own, through the bundle's policy. */
export const ExtendGrant = z.object({
  durationMinutes: Minutes,
  reason: z.string().trim().max(1000).optional(),
});
export type ExtendGrant = z.infer<typeof ExtendGrant>;

/**
 * A request a service files (machine API, `requests:create`): an agent's own request (an agent client may ask only
 * for itself), or an intake flow asking for a person. A service never break-glasses, and a request it files for a
 * person is never auto-approved: a person must decide it.
 */
export const ServiceCreateRequest = CreateRequest.omit({ breakGlass: true }).extend({ subjectId: z.uuid() });
export type ServiceCreateRequest = z.infer<typeof ServiceCreateRequest>;

/**
 * Tickets a flow hands to the current step's approvers in a chat (one each, in a direct message): a vote relayed with
 * a ticket is that approver's, for that request and step, once. Only for steps whose policy allows relayed votes.
 */
export const RelayTicket = z.object({ decider: IdentityRef, ticket: z.string(), expiresAt: z.iso.datetime() });
export const RelayTicketList = z.object({ items: z.array(RelayTicket) });

/** A vote an approver cast in a chat, relayed by a flow (`decisions:relay`). */
export const RelayDecision = z.object({
  ticket: z.string().min(20).max(4000),
  outcome: z.enum(['approve', 'deny']),
  comment: z.string().trim().max(1000).optional(),
  /** Where they voted: chat:slack, chat:teams… */
  channel: z.string().regex(/^chat:[a-z0-9-]{1,30}$/),
  /** What the chat said about who clicked (Slack user and team ids), kept with the vote. */
  evidence: z.record(z.string(), z.string().max(200)).optional(),
});
export type RelayDecision = z.infer<typeof RelayDecision>;

/** What a flow reports for one target of a grant. */
export const ReportTarget = z.object({
  status: z.enum(['provisioned', 'failed', 'revoked', 'revoke_failed', 'verified', 'drift']),
  detail: z.string().max(2000).optional(),
  externalRef: z.string().max(500).optional(),
});
export type ReportTarget = z.infer<typeof ReportTarget>;

export const PutAnnotation = z.object({ value: z.unknown() });
export const AnnotationView = z.object({ key: z.string(), value: z.unknown(), version: z.number().int() });

/** A flow waiting on a request: Landbright calls `resumeUrl` (POST, no body that matters) when the request changes. */
export const AttachWait = z.object({ resumeUrl: z.url() });

export const GrantSummary = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  ref: z.string(),
  bundle: z.object({ id: z.uuid(), name: z.string() }),
  subject: IdentityRef,
  status: GrantStatus,
  startsAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  targets: z.array(GrantTargetView),
});
export const GrantList = z.object({ items: z.array(GrantSummary) });
