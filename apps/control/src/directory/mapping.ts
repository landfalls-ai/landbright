import type { Agent, GroupRef, IdentityRef, Person } from '@landbright/contracts';
import { Prisma } from '@landbright/persistence';
import { isoDate } from '../common/tenant-db';

export const personInclude = {
  person: true,
  credentials: { where: { kind: 'password' }, select: { id: true } },
  memberships: { include: { group: { select: { id: true, name: true } } } },
} satisfies Prisma.IdentityInclude;
export type PersonRow = Prisma.IdentityGetPayload<{ include: typeof personInclude }>;

export const agentInclude = {
  agent: { include: { sponsor: true } },
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
    hasPassword: row.credentials.length > 0,
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
    groups: groupsOf(row.memberships),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const displayNameOf = (givenName: string, familyName: string) => `${givenName} ${familyName}`.trim();
