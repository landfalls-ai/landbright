import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateSubscription, Delivery, Subscription } from '@landbright/contracts';
import { appendAudit, type Prisma } from '@landbright/persistence';
import { audited, type Principal, type ServicePrincipal } from '../common/principal';
import { TenantDb } from '../common/tenant-db';

/**
 * The event types Landbright emits: every audit action is an event (docs/events.md). This is the catalog the console
 * offers when subscribing; a subscription may also name a prefix (`identity.*`) or `*`.
 */
export const EVENT_TYPES = [
  'identity.created',
  'identity.updated',
  'identity.invited',
  'identity.deactivated',
  'identity.reactivated',
  'identity.required_actions_set',
  'session.signed_in',
  'session.sign_in_failed',
  'credential.password_set',
  'credential.totp_added',
  'credential.passkey_added',
  'credential.second_step_reset',
  'credential.password_reset',
  'credential.removed',
  'credential.recovery_codes_created',
  'credential.recovery_code_used',
  'identity.terms_accepted',
  'session.others_ended',
  'group.created',
  'group.updated',
  'group.deleted',
  'group.member_added',
  'group.member_removed',
  'client.created',
  'client.updated',
  'client.deleted',
  'client.secret_rotated',
  'bundle.created',
  'bundle.updated',
  'request.created',
  'request.vote_recorded',
  'request.decision_refused',
  'request.escalated',
  'request.break_glass',
  'request.decided',
  'request.relay_tickets_issued',
  'grant.activated',
  'grant.extended',
  'grant.expiring',
  'grant.expired',
  'grant.revoked',
  'grant.target_provisioned',
  'grant.target_failed',
  'grant.target_revoked',
  'grant.target_revoke_failed',
  'grant.target_verified',
  'grant.target_drift',
  'grant.revoke_overdue',
  'tenant.sign_in_changed',
  'signing_key.rotated',
];

/** Whether an action matches a subscription's patterns: exact, a prefix ending in `*` (`grant.*`), or `*`. */
export function matches(patterns: string[], action: string): boolean {
  return patterns.some((p) => p === action || (p.endsWith('*') && action.startsWith(p.slice(0, -1))));
}

type SubscriptionRow = Prisma.EventSubscriptionGetPayload<object>;

@Injectable()
export class EventsService {
  constructor(private readonly db: TenantDb) {}

  /** Every subscription, or (for an application on the machine API) only its own. */
  async list(ownerClientId?: string): Promise<Subscription[]> {
    return this.db.tx(async (tx) => {
      const rows = await tx.eventSubscription.findMany({
        where: ownerClientId ? { ownerClientId } : {},
        orderBy: { createdAt: 'asc' },
      });
      return Promise.all(rows.map((r) => this.toSubscription(tx, r)));
    });
  }

  async create(input: CreateSubscription, actor: Principal | ServicePrincipal): Promise<Subscription> {
    const url = new URL(input.url);
    if (url.username || url.password) throw new BadRequestException('Put no credentials in the URL.');
    return this.db.tx(async (tx) => {
      if (actor.kind === 'service') {
        const client = await tx.oidcClient.findUnique({ where: { clientId: actor.clientId } });
        const origins = new Set((client?.redirectUris ?? []).map((u) => new URL(u).origin));
        if (!origins.has(url.origin))
          throw new BadRequestException(
            `An application subscribes only at its own origins (its redirect URIs): ${url.origin} isn’t one.`,
          );
      }
      // Start after the newest audit event, or `replay` events before it (to try a new flow on recent history).
      const newest = await tx.auditEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const cursor = (newest?.id ?? 0n) - BigInt(input.replay);
      const row = await tx.eventSubscription.create({
        data: {
          tenantId: this.db.tenantId,
          url: url.href,
          events: input.events,
          description: input.description,
          audience: input.audience ?? url.origin,
          cursor: cursor < 0n ? 0n : cursor,
          createdBy: actor.kind === 'person' ? actor.displayName : `${actor.name} (service)`,
          ownerClientId: actor.kind === 'service' ? actor.clientId : null,
        },
      });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'subscription.created',
        targetType: 'subscription',
        targetId: row.id,
        data: { url: row.url, events: row.events },
      });
      return this.toSubscription(tx, row);
    });
  }

  async update(
    id: string,
    input: { events?: string[]; description?: string; disabled?: boolean },
    actor: Principal,
  ): Promise<Subscription> {
    return this.db.tx(async (tx) => {
      await this.find(tx, id);
      const row = await tx.eventSubscription.update({ where: { id }, data: input });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'subscription.updated',
        targetType: 'subscription',
        targetId: id,
        data: input,
      });
      return this.toSubscription(tx, row);
    });
  }

  async remove(id: string, actor: Principal | ServicePrincipal): Promise<void> {
    await this.db.tx(async (tx) => {
      const row = await this.find(tx, id);
      if (actor.kind === 'service' && row.ownerClientId !== actor.clientId)
        throw new NotFoundException('No such subscription.');
      await tx.eventSubscription.delete({ where: { id } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'subscription.deleted',
        targetType: 'subscription',
        targetId: id,
        data: { url: row.url },
      });
    });
  }

  async deliveries(subscriptionId: string, status?: string): Promise<Delivery[]> {
    return this.db.tx(async (tx) => {
      await this.find(tx, subscriptionId);
      const rows = await tx.eventDelivery.findMany({
        where: { subscriptionId, ...(status && { status }) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return rows.map((d) => ({
        id: d.id,
        subscriptionId: d.subscriptionId,
        auditEventId: d.auditEventId.toString(),
        action: d.action,
        status: d.status as Delivery['status'],
        attempts: d.attempts,
        nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
        lastStatus: d.lastStatus,
        lastError: d.lastError,
        response: d.response ?? null,
        deliveredAt: d.deliveredAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
      }));
    });
  }

  /** Sends a delivery again (a failed one, or to re-run a flow). */
  async resend(deliveryId: string, actor: Principal): Promise<void> {
    await this.db.tx(async (tx) => {
      const d = await tx.eventDelivery.findFirst({ where: { id: deliveryId } });
      if (!d) throw new NotFoundException('No such delivery.');
      await tx.eventDelivery.update({
        where: { id: deliveryId },
        data: { status: 'pending', nextAttemptAt: new Date(), attempts: 0, createdAt: new Date() },
      });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'subscription.delivery_resent',
        targetType: 'subscription',
        targetId: d.subscriptionId,
        data: { deliveryId, action: d.action, auditEventId: d.auditEventId.toString() },
      });
    });
  }

  private async find(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.eventSubscription.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('No such subscription.');
    return row;
  }

  private async toSubscription(tx: Prisma.TransactionClient, r: SubscriptionRow): Promise<Subscription> {
    const counts = await tx.eventDelivery.groupBy({
      by: ['status'],
      where: { subscriptionId: r.id },
      _count: { _all: true },
    });
    const count = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
    return {
      id: r.id,
      url: r.url,
      events: r.events,
      description: r.description,
      audience: r.audience,
      disabled: r.disabled,
      createdBy: r.createdBy,
      ownerClientId: r.ownerClientId,
      createdAt: r.createdAt.toISOString(),
      stats: { pending: count('pending'), delivered: count('delivered'), failed: count('failed') },
    };
  }
}
