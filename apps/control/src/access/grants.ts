import { type AccessPolicy, type BundleTarget } from '@landbright/contracts';
import { ADMINS_GROUP, appendAudit, type Prisma } from '@landbright/persistence';

/**
 * The parts of just-in-time access that run inside someone else's transaction: who a policy names as approvers,
 * creating, activating and closing grants. Every change appends its audit event in the same transaction, and those
 * events are what Landflow flows receive (docs/access.md).
 */

export type Tx = Prisma.TransactionClient;
export type Who = { actorId: string | null; actorLabel: string };
export const SYSTEM: Who = { actorId: null, actorLabel: 'system' };

/** One approver as the request remembers them: who, and why the policy named them. */
export interface NamedApprover {
  id: string;
  /** group:<id>, identity, manager, bundle_owner, sponsor, fallback:bundle_owner, fallback:admins, escalation:<id> */
  via: string;
}

export interface ApproverContext {
  requesterId: string;
  subjectId: string;
  actingForId: string | null;
  bundleOwnerId: string | null;
}

/** People in these groups by a standing membership (not one a grant gave), active. */
async function standingMembers(tx: Tx, groupIds: string[]): Promise<Array<{ identityId: string; groupId: string }>> {
  if (groupIds.length === 0) return [];
  return tx.membership.findMany({
    where: {
      groupId: { in: groupIds },
      source: { not: 'grant' },
      identity: { kind: 'person', status: 'active' },
    },
    select: { identityId: true, groupId: true },
  });
}

async function activePeople(tx: Tx, ids: Array<string | null | undefined>): Promise<Set<string>> {
  const wanted = ids.filter((id): id is string => !!id);
  if (wanted.length === 0) return new Set();
  const rows = await tx.identity.findMany({
    where: { id: { in: wanted }, kind: 'person', status: 'active' },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * The people one step names, never the requester, the subject or the person an agent acts for (that would be
 * approving your own request). Falls back to the bundle owner, then the administrators, when a step names nobody
 * else; returns [] when even they can't, and the caller refuses the request.
 */
export async function resolveStep(
  tx: Tx,
  step: AccessPolicy['steps'][number],
  fallback: AccessPolicy['approverFallback'],
  ctx: ApproverContext,
): Promise<NamedApprover[]> {
  const excluded = new Set([ctx.requesterId, ctx.subjectId, ctx.actingForId].filter(Boolean));
  const named: NamedApprover[] = [];
  const add = (id: string, via: string) => {
    if (!excluded.has(id) && !named.some((n) => n.id === id)) named.push({ id, via });
  };
  for (const m of await standingMembers(tx, step.approvers.groupIds)) add(m.identityId, `group:${m.groupId}`);
  const direct = await activePeople(tx, step.approvers.identityIds);
  for (const id of step.approvers.identityIds) if (direct.has(id)) add(id, 'identity');

  const subject = await tx.identity.findFirst({
    where: { id: ctx.subjectId },
    include: { person: { select: { managerId: true } }, agent: { select: { sponsorId: true } } },
  });
  const sponsorId = subject?.agent?.sponsorId ?? null;
  // An agent's manager is its sponsor's manager.
  const managerOf = subject?.person?.managerId
    ? subject.person.managerId
    : sponsorId
      ? (await tx.personProfile.findFirst({ where: { identityId: sponsorId }, select: { managerId: true } }))?.managerId
      : null;
  const extras = await activePeople(tx, [managerOf, ctx.bundleOwnerId, sponsorId]);
  if (step.approvers.manager && managerOf && extras.has(managerOf)) add(managerOf, 'manager');
  if (step.approvers.bundleOwner && ctx.bundleOwnerId && extras.has(ctx.bundleOwnerId))
    add(ctx.bundleOwnerId, 'bundle_owner');
  if (step.approvers.sponsor && sponsorId && extras.has(sponsorId)) add(sponsorId, 'sponsor');

  if (named.length > 0) return named;
  for (const kind of fallback) {
    if (kind === 'bundleOwner' && ctx.bundleOwnerId && extras.has(ctx.bundleOwnerId))
      add(ctx.bundleOwnerId, 'fallback:bundle_owner');
    if (kind === 'admins') {
      const admins = await tx.group.findFirst({ where: { name: ADMINS_GROUP }, select: { id: true } });
      for (const m of await standingMembers(tx, admins ? [admins.id] : [])) add(m.identityId, 'fallback:admins');
    }
    if (named.length > 0) break;
  }
  return named;
}

/** Whether someone the request named still holds the reason they were named (a group they may have left since). */
export async function stillNamed(tx: Tx, approver: NamedApprover): Promise<boolean> {
  const person = await activePeople(tx, [approver.id]);
  if (!person.has(approver.id)) return false;
  const group = /^(?:group|escalation):(.+)$/.exec(approver.via)?.[1];
  if (!group) return true;
  return (await standingMembers(tx, [group])).some((m) => m.identityId === approver.id);
}

// ---------------------------------------------------------------- grants

export const GROUP_TARGET = 'landbright-group';

/** Creates the grant of an approved request: active at once, or scheduled for its start. */
export async function createGrant(
  tx: Tx,
  tenantId: string,
  request: { id: string; bundleId: string; subjectId: string; durationSeconds: number; startsAt: Date | null },
  bundle: { groupIds: string[]; targets: BundleTarget[] },
  who: Who,
  options: { breakGlass?: boolean; now?: Date } = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const startsAt = request.startsAt && request.startsAt > now ? request.startsAt : now;
  const groups = await tx.group.findMany({ where: { id: { in: bundle.groupIds } }, select: { id: true, name: true } });
  const grant = await tx.accessGrant.create({
    data: {
      tenantId,
      requestId: request.id,
      bundleId: request.bundleId,
      subjectId: request.subjectId,
      status: 'scheduled',
      startsAt,
      expiresAt: new Date(startsAt.getTime() + request.durationSeconds * 1000),
      isBreakGlass: options.breakGlass ?? false,
      targets: {
        create: [
          ...groups.map((g) => ({
            tenantId,
            key: `group:${g.id}`,
            type: GROUP_TARGET,
            label: g.name,
            managedBy: 'landbright',
            status: 'pending',
          })),
          ...bundle.targets.map((t) => ({
            tenantId,
            key: t.key,
            type: t.type,
            label: t.label,
            managedBy: 'flow',
            status: 'pending',
          })),
        ],
      },
    },
  });
  if (startsAt <= now) await activateGrant(tx, tenantId, grant.id, who, now);
  return grant.id;
}

/**
 * Starts a grant: adds the subject to each of the bundle's Landbright groups (unless they're already in it, standing
 * or through another grant: then nothing changes and nothing is removed at the end), then `grant.activated` for the
 * flows that provision the rest.
 */
export async function activateGrant(tx: Tx, tenantId: string, grantId: string, who: Who, now = new Date()) {
  const grant = await tx.accessGrant.findUniqueOrThrow({ where: { id: grantId }, include: { targets: true } });
  if (grant.status !== 'scheduled') return;
  const subject = await tx.identity.findUniqueOrThrow({ where: { id: grant.subjectId } });
  for (const target of grant.targets.filter((t) => t.managedBy === 'landbright')) {
    const groupId = target.key.slice('group:'.length);
    const existing = await tx.membership.findUnique({
      where: { groupId_identityId: { groupId, identityId: grant.subjectId } },
    });
    if (existing) {
      await tx.grantTarget.update({
        where: { id: target.id },
        data: { status: 'provisioned', externalRef: existing.grantId ? 'shared-with-grant' : 'already-member' },
      });
      continue;
    }
    await tx.membership.create({
      data: {
        tenantId,
        groupId,
        identityId: grant.subjectId,
        source: 'grant',
        grantId: grant.id,
        expiresAt: grant.expiresAt,
      },
    });
    await tx.grantTarget.update({
      where: { id: target.id },
      data: { status: 'provisioned', externalRef: 'membership', updatedBy: 'landbright' },
    });
    await appendAudit(tx, tenantId, {
      ...who,
      action: 'group.member_added',
      targetType: 'group',
      targetId: groupId,
      data: { group: target.label, identityId: subject.id, identity: subject.displayName, grantId: grant.id },
    });
  }
  await tx.accessGrant.update({ where: { id: grantId }, data: { status: 'active', activatedAt: now } });
  await appendAudit(tx, tenantId, {
    ...who,
    action: 'grant.activated',
    targetType: 'grant',
    targetId: grantId,
    data: { requestId: grant.requestId, subjectId: grant.subjectId, expiresAt: grant.expiresAt.toISOString() },
  });
}

/**
 * Ends a grant: removes the memberships it added (handing a membership to another live grant that gives the same
 * group, so it isn't removed from under it), marks the Landbright targets revoked, and appends `grant.expired` or
 * `grant.revoked`. Targets a flow provisioned stay `provisioned` until the flow reports them revoked; the sweeper
 * raises `grant.revoke_overdue` if it doesn't.
 */
export async function closeGrant(
  tx: Tx,
  tenantId: string,
  grantId: string,
  outcome: 'expired' | 'revoked',
  closingReason: string,
  who: Who,
  now = new Date(),
) {
  const grant = await tx.accessGrant.findUniqueOrThrow({ where: { id: grantId }, include: { targets: true } });
  if (grant.status === 'expired' || grant.status === 'revoked') return;
  const subject = await tx.identity.findUniqueOrThrow({ where: { id: grant.subjectId } });
  for (const target of grant.targets) {
    if (target.managedBy === 'flow') {
      if (target.status === 'pending' || target.status === 'failed')
        await tx.grantTarget.update({
          where: { id: target.id },
          data: { status: 'revoked', lastError: 'Never provisioned', updatedBy: 'landbright' },
        });
      continue;
    }
    const groupId = target.key.slice('group:'.length);
    const membership = await tx.membership.findFirst({ where: { groupId, identityId: grant.subjectId, grantId } });
    if (membership) {
      const heir = await tx.accessGrant.findFirst({
        where: {
          id: { not: grantId },
          subjectId: grant.subjectId,
          status: 'active',
          targets: { some: { key: target.key } },
        },
        orderBy: { expiresAt: 'desc' },
      });
      if (heir) {
        await tx.membership.update({
          where: { groupId_identityId: { groupId, identityId: grant.subjectId } },
          data: { grantId: heir.id, expiresAt: heir.expiresAt },
        });
      } else {
        await tx.membership.delete({ where: { groupId_identityId: { groupId, identityId: grant.subjectId } } });
        await appendAudit(tx, tenantId, {
          ...who,
          action: 'group.member_removed',
          targetType: 'group',
          targetId: groupId,
          data: { group: target.label, identityId: subject.id, identity: subject.displayName, grantId, closingReason },
        });
      }
    }
    await tx.grantTarget.update({ where: { id: target.id }, data: { status: 'revoked', updatedBy: 'landbright' } });
  }
  await tx.accessGrant.update({ where: { id: grantId }, data: { status: outcome, closedAt: now, closingReason } });
  await appendAudit(tx, tenantId, {
    ...who,
    action: outcome === 'expired' ? 'grant.expired' : 'grant.revoked',
    targetType: 'grant',
    targetId: grantId,
    data: { requestId: grant.requestId, subjectId: grant.subjectId, closingReason },
  });
}

/** A leaver: every live grant of these identities ends now (the person, and the agents they sponsor). */
export async function closeGrantsOf(tx: Tx, tenantId: string, identityIds: string[], who: Who): Promise<number> {
  const grants = await tx.accessGrant.findMany({
    where: { subjectId: { in: identityIds }, status: { in: ['scheduled', 'active'] } },
    select: { id: true },
  });
  for (const g of grants) await closeGrant(tx, tenantId, g.id, 'revoked', 'leaver', who);
  const pending = await tx.accessRequest.findMany({
    where: { status: 'pending', OR: [{ subjectId: { in: identityIds } }, { requesterId: { in: identityIds } }] },
    select: { id: true },
  });
  for (const r of pending) {
    await tx.accessRequest.update({
      where: { id: r.id },
      data: { status: 'cancelled', closingReason: 'leaver', decidedAt: new Date() },
    });
    await appendAudit(tx, tenantId, {
      ...who,
      action: 'request.decided',
      targetType: 'request',
      targetId: r.id,
      data: { outcome: 'cancelled', closingReason: 'leaver' },
    });
  }
  return grants.length;
}
