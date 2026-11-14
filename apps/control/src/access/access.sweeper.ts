import { Injectable } from '@nestjs/common';
import { AccessPolicy } from '@landbright/contracts';
import { appendAudit, type Prisma } from '@landbright/persistence';
import { TenantDb } from '../common/tenant-db';
import { refOf } from './access.service';
import { activateGrant, closeGrant, type NamedApprover, SYSTEM } from './grants';

const MINUTE = 60_000;
/** A target a flow provisioned and hasn't reported revoked this long after the grant ended. */
const REVOKE_OVERDUE_MS = 15 * MINUTE;

/**
 * Landbright's backstop: the timers that keep access honest whatever a flow does. Undecided requests expire at their
 * deadline; escalation adds approvers; scheduled grants start; `grant.expiring` goes out; at the end the Landbright
 * side (group memberships) is removed and `grant.expired` sent; a target still provisioned well after that raises
 * `grant.revoke_overdue`. Runs inside the event worker's loop, under its lock.
 */
@Injectable()
export class AccessSweeper {
  constructor(private readonly db: TenantDb) {}

  async sweep(now = new Date()): Promise<void> {
    const tenantId = this.db.tenantId;
    await this.db.tx(async (tx) => {
      for (const r of await tx.accessRequest.findMany({ where: { status: 'pending', deadline: { lte: now } } })) {
        await tx.accessRequest.update({
          where: { id: r.id },
          data: { status: 'expired', decidedAt: now, closingReason: 'deadline' },
        });
        await appendAudit(tx, tenantId, {
          ...SYSTEM,
          action: 'request.decided',
          targetType: 'request',
          targetId: r.id,
          data: { ref: refOf(r.number), outcome: 'expired' },
        });
      }
      await this.escalate(tx, tenantId, now);
      for (const g of await tx.accessGrant.findMany({ where: { status: 'scheduled', startsAt: { lte: now } } }))
        await activateGrant(tx, tenantId, g.id, SYSTEM, now);
      const active = await tx.accessGrant.findMany({
        where: { status: 'active' },
        include: { request: { include: { bundle: true } } },
      });
      for (const g of active) {
        if (g.expiresAt <= now) {
          await closeGrant(tx, tenantId, g.id, 'expired', 'expired', SYSTEM, now);
          continue;
        }
        const notice = AccessPolicy.parse(g.request.policySnapshot ?? {}).expiringNoticeMinutes * MINUTE;
        if (!g.expiringSentAt && g.expiresAt.getTime() - now.getTime() <= notice) {
          await tx.accessGrant.update({ where: { id: g.id }, data: { expiringSentAt: now } });
          await appendAudit(tx, tenantId, {
            ...SYSTEM,
            action: 'grant.expiring',
            targetType: 'grant',
            targetId: g.id,
            data: { ref: refOf(g.request.number), expiresAt: g.expiresAt.toISOString() },
          });
        }
      }
      const ended = await tx.accessGrant.findMany({
        where: {
          status: { in: ['expired', 'revoked'] },
          overdueSentAt: null,
          closedAt: { lte: new Date(now.getTime() - REVOKE_OVERDUE_MS) },
          targets: {
            some: { managedBy: 'flow', status: { in: ['provisioned', 'verified', 'revoke_failed', 'drift'] } },
          },
        },
        include: { targets: true, request: true },
      });
      for (const g of ended) {
        await tx.accessGrant.update({ where: { id: g.id }, data: { overdueSentAt: now } });
        await appendAudit(tx, tenantId, {
          ...SYSTEM,
          action: 'grant.revoke_overdue',
          targetType: 'grant',
          targetId: g.id,
          data: {
            ref: refOf(g.request.number),
            targets: g.targets.filter((t) => t.managedBy === 'flow' && t.status !== 'revoked').map((t) => t.key),
          },
        });
      }
    });
  }

  /** A pending request older than its policy's escalation time gets the escalation groups' people as approvers. */
  private async escalate(tx: Prisma.TransactionClient, tenantId: string, now: Date) {
    const pending = await tx.accessRequest.findMany({ where: { status: 'pending' } });
    for (const r of pending) {
      const policy = AccessPolicy.parse(r.policySnapshot ?? {});
      if (!policy.escalation) continue;
      if (now.getTime() - r.createdAt.getTime() < policy.escalation.afterMinutes * MINUTE) continue;
      const steps = r.approvers as unknown as Array<{ approvers: NamedApprover[]; escalatedAt?: string }>;
      const step = steps[r.currentStep];
      if (!step || step.escalatedAt) continue;
      const excluded = new Set([r.requesterId, r.subjectId, r.actingForId].filter(Boolean));
      const members = await tx.membership.findMany({
        where: {
          groupId: { in: policy.escalation.toGroupIds },
          source: { not: 'grant' },
          identity: { kind: 'person', status: 'active' },
        },
        select: { identityId: true, groupId: true },
      });
      const added = members
        .filter((m) => !excluded.has(m.identityId) && !step.approvers.some((a) => a.id === m.identityId))
        .filter((m, i, all) => all.findIndex((x) => x.identityId === m.identityId) === i)
        .map((m) => ({ id: m.identityId, via: `escalation:${m.groupId}` }));
      // Marked escalated even when nobody new was found, so it isn't tried again every tick.
      step.approvers.push(...added);
      step.escalatedAt = now.toISOString();
      await tx.accessRequest.update({
        where: { id: r.id },
        data: { approvers: steps as unknown as Prisma.InputJsonValue },
      });
      await appendAudit(tx, tenantId, {
        ...SYSTEM,
        action: 'request.escalated',
        targetType: 'request',
        targetId: r.id,
        data: { ref: refOf(r.number), added: added.map((a) => a.id), afterMinutes: policy.escalation.afterMinutes },
      });
    }
  }
}
