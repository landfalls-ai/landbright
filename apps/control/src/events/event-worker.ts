import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { DeliveredEvent } from '@landbright/contracts';
import { type Prisma, TENANT, type TenantRef } from '@landbright/persistence';
import type { Redis } from 'ioredis';
import { AccessService } from '../access/access.service';
import { AccessSweeper } from '../access/access.sweeper';
import { KeyRing } from '../common/key-ring';
import { TenantDb } from '../common/tenant-db';
import { VALKEY } from '../common/tokens';
import { ScimSync } from '../provisioning/scim-sync';
import { matches } from './events.service';

const TICK_MS = 2_000;
const LOCK_MS = 30_000;
const GIVE_UP_MS = 24 * 3600_000;
const TIMEOUT_MS = 10_000;
const WAKE_ACTIONS = new Set(['request.vote_recorded', 'request.decided', 'request.escalated']);

/** 5 s, 10 s, 20 s … capped at an hour. */
export const backoffMs = (attempts: number) => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 3600_000);

/**
 * Events out, Landbright's version of Keycloak's event listener SPI, but transactional and retried: the audit log is
 * the outbox (an event exists if and only if its change committed), each subscription keeps a cursor into it, and
 * every matching event becomes a delivery, sent until it is answered 2xx or a day has passed.
 *
 * A delivery is `POST <url>` with the event as JSON and `Authorization: Bearer <JWT>`: the event again, signed by the
 * issuer's own key (a Security Event Token, RFC 8417), so Landflow's Webhook trigger checks it with its JWT Auth
 * credential pointed at Landbright's JWKS, with no shared secret. `Idempotency-Key` is the event id, which Landflow
 * uses to drop a repeat.
 *
 * The same loop, under one Valkey lock per tenant (one replica at a time), runs the access sweeper, pushes to the
 * provisioning targets (ScimSync, spec 006), and wakes Landflow runs waiting on a request (their resume URL, called with nothing in it but a nudge: the flow re-reads).
 */
@Injectable()
export class EventWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EventWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly owner = randomUUID();

  constructor(
    private readonly db: TenantDb,
    private readonly keys: KeyRing,
    private readonly access: AccessService,
    private readonly sweeper: AccessSweeper,
    private readonly scim: ScimSync,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(TENANT) private readonly tenant: TenantRef,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.LANDBRIGHT_WORKER === 'off') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private get lockKey() {
    return `lb:worker:${this.tenant.id}`;
  }

  /** One pass. Public so tests can drive it without timers. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const got = await this.valkey.set(this.lockKey, this.owner, 'PX', LOCK_MS, 'NX');
      const mine = got === 'OK' || (await this.valkey.get(this.lockKey)) === this.owner;
      if (!mine) return;
      await this.valkey.pexpire(this.lockKey, LOCK_MS);
      await this.sweeper.sweep();
      // Provisioning first: a deactivation reaches the applications before anything else is sent.
      await this.scim
        .tick()
        .catch((e) => this.logger.warn(`provisioning: ${e instanceof Error ? e.message : String(e)}`));
      await this.match();
      await this.send();
      await this.wake();
    } catch (error) {
      this.logger.warn(`events: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Each subscription's new matching audit events become deliveries. */
  private async match(): Promise<void> {
    await this.db.tx(async (tx) => {
      const subscriptions = await tx.eventSubscription.findMany({ where: { disabled: false } });
      for (const s of subscriptions) {
        const events = await tx.auditEvent.findMany({
          where: { id: { gt: s.cursor } },
          orderBy: { id: 'asc' },
          take: 500,
          select: { id: true, action: true },
        });
        if (events.length === 0) continue;
        const wanted = events.filter((e) => matches(s.events, e.action));
        if (wanted.length)
          await tx.eventDelivery.createMany({
            data: wanted.map((e) => ({
              tenantId: this.tenant.id,
              subscriptionId: s.id,
              auditEventId: e.id,
              action: e.action,
            })),
            skipDuplicates: true,
          });
        await tx.eventSubscription.update({ where: { id: s.id }, data: { cursor: events.at(-1)!.id } });
      }
    });
  }

  private async send(): Promise<void> {
    const due = await this.db.tx((tx) =>
      tx.eventDelivery.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: new Date() }, subscription: { disabled: false } },
        include: { subscription: true },
        orderBy: { createdAt: 'asc' },
        take: 25,
      }),
    );
    // In parallel across subscriptions (one slow endpoint doesn't hold up the others), in order within each.
    const bySubscription = new Map<string, typeof due>();
    for (const d of due) bySubscription.set(d.subscriptionId, [...(bySubscription.get(d.subscriptionId) ?? []), d]);
    await Promise.all(
      [...bySubscription.values()].map(async (queue) => {
        for (const d of queue) await this.deliver(d);
      }),
    );
  }

  /** The event as flows see it: the audit row, plus the request or grant as it is now (flows re-read anyway). */
  async event(auditEventId: bigint): Promise<DeliveredEvent> {
    const row = await this.db.tx((tx) => tx.auditEvent.findFirstOrThrow({ where: { id: auditEventId } }));
    const data: Record<string, unknown> = { ...(row.data as Record<string, unknown>) };
    try {
      if (row.targetType === 'request' && row.targetId) data.request = await this.access.view(row.targetId, {});
      if (row.targetType === 'grant' && row.targetId) data.grant = await this.access.grant(row.targetId);
      if (row.targetType === 'identity' && row.targetId)
        data.identity = await this.db.tx((tx) =>
          tx.identity.findFirst({
            where: { id: row.targetId! },
            select: { id: true, kind: true, displayName: true, email: true, status: true, lastSignInAt: true },
          }),
        );
    } catch {
      // Deleted since: the audit row's own data still says what happened.
    }
    return {
      id: `${this.tenant.slug}.${row.id}`,
      type: row.action,
      at: row.at.toISOString(),
      actor: { id: row.actorId, label: row.actorLabel },
      target: { type: row.targetType, id: row.targetId },
      data,
    };
  }

  private async deliver(d: Prisma.EventDeliveryGetPayload<{ include: { subscription: true } }>): Promise<void> {
    const attempts = d.attempts + 1;
    let status: number | null = null;
    let error: string | null = null;
    let response: unknown = null;
    try {
      const event = await this.event(d.auditEventId);
      const token = await this.keys.sign(
        {
          jti: event.id,
          sub: event.target.id ?? undefined,
          toe: Math.floor(new Date(event.at).getTime() / 1000),
          type: event.type,
          tenant: this.tenant.slug,
          event,
          events: { [`urn:landbright:event:${event.type}`]: {} },
        },
        { audience: d.subscription.audience, ttlSeconds: 300, type: 'secevent+jwt' },
      );
      const res = await fetch(d.subscription.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'idempotency-key': event.id,
          'webhook-id': event.id,
          'user-agent': 'Landbright-Events/1',
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
      status = res.status;
      const text = (await res.text()).slice(0, 4000);
      try {
        response = JSON.parse(text);
      } catch {
        response = text ? { text: text.slice(0, 500) } : null;
      }
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const delivered = status !== null && status >= 200 && status < 300;
    const expired = Date.now() - d.createdAt.getTime() > GIVE_UP_MS;
    await this.db.tx((tx) =>
      tx.eventDelivery.update({
        where: { id: d.id },
        data: {
          attempts,
          lastStatus: status,
          lastError: delivered ? null : error,
          response: (response ?? undefined) as Prisma.InputJsonValue | undefined,
          status: delivered ? 'delivered' : expired ? 'failed' : 'pending',
          deliveredAt: delivered ? new Date() : null,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        },
      }),
    );
    if (!delivered) this.logger.debug(`delivery ${d.id} (${d.action}) attempt ${attempts}: ${error}`);
  }

  /**
   * Wakes Landflow runs waiting on a request (`POST /api/v1/requests/:id/waits`): when the request gets a vote, a
   * decision or new approvers, its waits become due and their resume URLs are called. The call carries nothing that
   * matters; the flow re-reads the request. A call that fails is tried again (the deliveries' back-off) for up to a
   * day. A resume URL is only ever called at an origin some enabled subscription delivers to.
   */
  private async wake(): Promise<void> {
    const key = `lb:wake-cursor:${this.tenant.id}`;
    const stored = await this.valkey.get(key);
    const events = await this.db.tx(async (tx) => {
      if (stored === null) {
        const newest = await tx.auditEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
        await this.valkey.set(key, String(newest?.id ?? 0));
        return [];
      }
      return tx.auditEvent.findMany({
        where: { id: { gt: BigInt(stored) }, targetType: 'request' },
        orderBy: { id: 'asc' },
        take: 200,
        select: { id: true, action: true, targetId: true },
      });
    });
    const now = new Date();
    if (events.length) {
      const changed = [...new Set(events.filter((e) => WAKE_ACTIONS.has(e.action)).map((e) => e.targetId!))];
      if (changed.length)
        await this.db.tx(async (tx) => {
          const waits = await tx.annotation.findMany({
            where: { targetId: { in: changed }, key: { startsWith: 'wait.' } },
          });
          for (const w of waits) {
            const value = w.value as Wait;
            if (value.dueAt) continue;
            await tx.annotation.update({
              where: { targetId_key: { targetId: w.targetId, key: w.key } },
              data: { value: { ...value, dueAt: now.toISOString(), attempts: 0, nextAt: now.toISOString() } },
            });
          }
        });
      await this.valkey.set(key, String(events.at(-1)!.id));
    }

    const { due, origins } = await this.db.tx(async (tx) => ({
      due: (await tx.annotation.findMany({ where: { key: { startsWith: 'wait.' } } })).filter((w) => {
        const v = w.value as Wait;
        return v.dueAt && new Date(v.nextAt ?? v.dueAt) <= now;
      }),
      origins: new Set(
        (await tx.eventSubscription.findMany({ where: { disabled: false }, select: { url: true } })).map(
          (s) => new URL(s.url).origin,
        ),
      ),
    }));
    await Promise.all(
      due.map(async (wait) => {
        const value = wait.value as Wait;
        let done = true;
        if (value.resumeUrl && origins.has(new URL(value.resumeUrl).origin)) {
          try {
            const res = await fetch(value.resumeUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'user-agent': 'Landbright-Events/1' },
              body: JSON.stringify({ requestId: wait.targetId, nudge: true }),
              signal: AbortSignal.timeout(TIMEOUT_MS),
              redirect: 'manual',
            });
            // Gone or already resumed: nothing to wake.
            done = res.ok || res.status === 404 || res.status === 409 || res.status === 410;
          } catch {
            done = false;
          }
        }
        const attempts = (value.attempts ?? 0) + 1;
        const gaveUp = !done && now.getTime() - new Date(value.dueAt!).getTime() > GIVE_UP_MS;
        await this.db.tx(async (tx) => {
          // Only if the flow hasn't attached a new wait meanwhile (a new resume URL is a new wait).
          const current = await tx.annotation.findUnique({
            where: { targetId_key: { targetId: wait.targetId, key: wait.key } },
          });
          if (!current || current.version !== wait.version) return;
          if (done || gaveUp)
            await tx.annotation.delete({ where: { targetId_key: { targetId: wait.targetId, key: wait.key } } });
          else
            await tx.annotation.update({
              where: { targetId_key: { targetId: wait.targetId, key: wait.key } },
              data: {
                value: { ...value, attempts, nextAt: new Date(now.getTime() + backoffMs(attempts)).toISOString() },
              },
            });
        });
        if (gaveUp) this.logger.warn(`gave up waking ${wait.key} on request ${wait.targetId} after ${attempts} tries`);
      }),
    );
  }
}

/** A flow's wait on a request, kept as an annotation (`wait.<client id>`). */
interface Wait {
  resumeUrl?: string;
  at?: string;
  /** Set when the request changed: the resume URL is due to be called. */
  dueAt?: string;
  attempts?: number;
  nextAt?: string;
}
