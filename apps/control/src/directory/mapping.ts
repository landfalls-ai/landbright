import { type Agent, type GroupRef, type IdentityRef, type Person, RequiredAction } from '@landbright/contracts';
import { Prisma } from '@landbright/persistence';
import { isoDate } from '../common/tenant-db';

export const personInclude = {
  person: true,
  credentials: {
    where: { kind: { in: ['password', 'totp', 'passkey', 'recovery_code'] } },
    select: { id: true, kind: true },
  },
  memberships: { include: { group: { select: { id: true, name: true } } } },
  sources: { select: { source: true, sourceId: true, lastSeenAt: true }, orderBy: { source: 'asc' } },
} satisfies Prisma.IdentityInclude;
export type PersonRow = Prisma.IdentityGetPayload<{ include: typeof personInclude }>;

export const agentInclude = {
  agent: { include: { sponsor: true } },
  application: { select: { id: true, clientId: true, grantTypes: true } },
  memberships: { include: { group: { select: { id: true, name: true } } } },
} satisfies Prisma.IdentityInclude;
export type AgentRow = Prisma.IdentityGetPayload<{ include: typeof agentInclude }>;

type IdentityBase = {
  id: string;
  kind: IdentityRef['kind'];
  displayName: string;
  email: string | null;
  status: IdentityRef['status'];
};

export const toRef = (i: IdentityBase): IdentityRef => ({
  id: i.id,
  kind: i.kind,
  displayName: i.displayName,
  email: i.email,
  status: i.status,
});

const groupsOf = (memberships: Array<{ group: GroupRef }>): GroupRef[] =>
  memberships.map((m) => ({ id: m.group.id, name: m.group.name })).sort((a, b) => a.name.localeCompare(b.name));

export function toPerson(row: PersonRow, managers: Map<string, IdentityBase>): Person {
  const p = row.person;
  const manager = p?.managerId ? managers.get(p.managerId) : undefined;
  return {
    ...toRef(row),
    kind: 'person',
    givenName: p?.givenName ?? row.displayName,
    familyName: p?.familyName ?? '',
    department: p?.department ?? null,
    title: p?.title ?? null,
    site: p?.site ?? null,
    manager: manager ? toRef(manager) : null,
    startDate: isoDate(p?.startDate),
    endDate: isoDate(p?.endDate),
    groups: groupsOf(row.memberships),
    hasPassword: row.credentials.some((c) => c.kind === 'password'),
    hasTotp: row.credentials.some((c) => c.kind === 'totp'),
    passkeys: row.credentials.filter((c) => c.kind === 'passkey').length,
    recoveryCodes: row.credentials.filter((c) => c.kind === 'recovery_code').length,
    requiredActions: row.requiredActions.filter((a): a is RequiredAction => RequiredAction.safeParse(a).success),
    sources: row.sources.map((s) => ({
      source: s.source,
      sourceId: s.sourceId,
      lastSeenAt: s.lastSeenAt.toISOString(),
    })),
    termsAcceptedAt: row.termsAcceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAgent(row: AgentRow): Agent {
  const a = row.agent!;
  return {
    ...toRef(row),
    kind: 'agent',
    sponsor: toRef(a.sponsor),
    purpose: a.purpose,
    riskTier: a.riskTier,
    runtime: a.runtime,
    homeProject: a.homeProject,
    maxTokenTtlSeconds: a.maxTokenTtlSeconds,
    actFor: a.actFor,
    application: row.application,
    groups: groupsOf(row.memberships),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const displayNameOf = (givenName: string, familyName: string) => `${givenName} ${familyName}`.trim();
