import { z } from 'zod';

/** The directory: people, agents, groups. docs/reference/api.md lists the routes. */

export const IdentityKind = z.enum(['person', 'agent', 'service']);
export type IdentityKind = z.infer<typeof IdentityKind>;
export const IdentityStatus = z.enum(['pre_hire', 'active', 'suspended', 'deactivated']);
export type IdentityStatus = z.infer<typeof IdentityStatus>;

const Email = z.email().transform((e) => e.toLowerCase());
const Name = z.string().trim().min(1).max(200);
const Optional = z.string().trim().max(200).optional();
const IsoDate = z.iso.date();

/** A reference to an identity, as lists and pickers show it. */
export const IdentityRef = z.object({
  id: z.uuid(),
  kind: IdentityKind,
  displayName: z.string(),
  email: z.string().nullable(),
  status: IdentityStatus,
});
export type IdentityRef = z.infer<typeof IdentityRef>;

export const GroupRef = z.object({ id: z.uuid(), name: z.string() });
export type GroupRef = z.infer<typeof GroupRef>;

// ---------------------------------------------------------------- people

export const Person = IdentityRef.extend({
  kind: z.literal('person'),
  givenName: z.string(),
  familyName: z.string(),
  department: z.string().nullable(),
  title: z.string().nullable(),
  site: z.string().nullable(),
  manager: IdentityRef.nullable(),
  startDate: IsoDate.nullable(),
  endDate: IsoDate.nullable(),
  groups: z.array(GroupRef),
  /** Whether a password is set; false until the person accepts their invite. */
  hasPassword: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Person = z.infer<typeof Person>;

export const CreatePerson = z.object({
  email: Email,
  givenName: Name,
  familyName: z.string().trim().max(200).default(''),
  department: Optional,
  title: Optional,
  site: Optional,
  managerId: z.uuid().optional(),
  startDate: IsoDate.optional(),
  groupIds: z.array(z.uuid()).default([]),
  /** Email an invite link to set a password (Mailpit in development). */
  sendInvite: z.boolean().default(true),
});
export type CreatePerson = z.input<typeof CreatePerson>;

export const UpdatePerson = z.object({
  givenName: Name.optional(),
  familyName: z.string().trim().max(200).optional(),
  department: z.string().trim().max(200).nullable().optional(),
  title: z.string().trim().max(200).nullable().optional(),
  site: z.string().trim().max(200).nullable().optional(),
  managerId: z.uuid().nullable().optional(),
  startDate: IsoDate.nullable().optional(),
  endDate: IsoDate.nullable().optional(),
});
export type UpdatePerson = z.input<typeof UpdatePerson>;

export const InviteResult = z.object({
  sentTo: z.string(),
  expiresAt: z.iso.datetime(),
});
export type InviteResult = z.infer<typeof InviteResult>;

// ---------------------------------------------------------------- agents

export const RiskTier = z.enum(['low', 'elevated', 'privileged']);
export type RiskTier = z.infer<typeof RiskTier>;
export const AgentRuntime = z.enum(['landflow', 'kagent', 'claude_code', 'external']);
export type AgentRuntime = z.infer<typeof AgentRuntime>;
export const ActFor = z.enum(['anyone', 'sponsor', 'nobody']);
export type ActFor = z.infer<typeof ActFor>;

export const Agent = IdentityRef.extend({
  kind: z.literal('agent'),
  sponsor: IdentityRef,
  purpose: z.string(),
  riskTier: RiskTier,
  runtime: AgentRuntime,
  homeProject: z.string().nullable(),
  maxTokenTtlSeconds: z.number().int(),
  actFor: ActFor,
  groups: z.array(GroupRef),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof Agent>;

export const CreateAgent = z.object({
  displayName: Name,
  /** The accountable person (constitution principle III). Must be an active person. */
  sponsorId: z.uuid(),
  purpose: z.string().trim().min(1).max(500),
  riskTier: RiskTier.default('low'),
  runtime: AgentRuntime.default('landflow'),
  homeProject: Optional,
  maxTokenTtlSeconds: z.number().int().min(60).max(3600).default(900),
  actFor: ActFor.default('sponsor'),
});
export type CreateAgent = z.input<typeof CreateAgent>;

export const UpdateAgent = CreateAgent.partial().extend({
  homeProject: z.string().trim().max(200).nullable().optional(),
});
export type UpdateAgent = z.input<typeof UpdateAgent>;

// ---------------------------------------------------------------- groups

export const GroupKind = z.enum(['static', 'birthright', 'jit']);
export type GroupKind = z.infer<typeof GroupKind>;

export const Group = GroupRef.extend({
  description: z.string().nullable(),
  kind: GroupKind,
  memberCount: z.number().int(),
  /** Landbright's own administrators: membership opens the console. */
  system: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Group = z.infer<typeof Group>;

export const GroupMember = IdentityRef.extend({
  source: z.enum(['manual', 'hr', 'grant']),
  expiresAt: z.iso.datetime().nullable(),
  addedAt: z.iso.datetime(),
});
export type GroupMember = z.infer<typeof GroupMember>;

export const GroupDetail = Group.extend({ members: z.array(GroupMember) });
export type GroupDetail = z.infer<typeof GroupDetail>;

/** Group names travel in tokens (`roles`, `groups`) and apps map them, so keep them stable and plain. */
export const GroupName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^,=]+$/, 'A group name can’t contain , or = (apps map names in key=value lists).');

export const CreateGroup = z.object({
  name: GroupName,
  description: z.string().trim().max(500).optional(),
  kind: GroupKind.default('static'),
});
export type CreateGroup = z.input<typeof CreateGroup>;

export const AddMember = z.object({ identityId: z.uuid() });
export type AddMember = z.infer<typeof AddMember>;

export const Page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) });
export const PeopleList = Page(Person);
export const AgentList = Page(Agent);
export const GroupList = Page(Group);
