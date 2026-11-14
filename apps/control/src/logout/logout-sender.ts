import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { appendAudit, type Prisma } from '@landbright/persistence';
import { KeyRing } from '../common/key-ring';
import { TenantDb } from '../common/tenant-db';

const BATCH = 50;
const LABEL = 'Back-channel logout';
const TIMEOUT_MS = 10_000;
/** Ten tries, 5 s doubling (about 85 minutes in all), then the delivery is given up and recorded as failed. */
export const MAX_ATTEMPTS = 10;
export const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
/** A logout token is for now: it lives two minutes (signed when each try is sent, not when it was queued). */
const TOKEN_TTL_SECONDS = 120;

type Delivery = Prisma.LogoutDeliveryGetPayload<object>;

export const logoutRetryInMs = (attempts: number) => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 3600_000);

/** The claims of a logout token (OpenID Back-Channel Logout 1.0 §2.4); iss, aud, iat and exp are added on signing. */
export function logoutClaims(d: Pick<Delivery, 'subject' | 'sid'>, jti: string = randomUUID()) {
  return { sub: d.subject, ...(d.sid && { sid: d.sid }), jti, events: { [LOGOUT_EVENT]: {} } };
}

/**
 * Sends the logout tokens queued when sessions ended (libs/persistence logout.ts): `POST <backchannel_logout_uri>`
 * with `logout_token=<JWT>` as a form, signed by the issuer's key with `typ: logout+jwt`. 200 or 204 is delivered;
 * anything else is tried again with backoff, up to ten times. Each outcome is in the audit log. Run from the event
 * worker's loop, under its lock (one replica at a time).
 */
@Injectable()
export class LogoutSender {
  constructor(
    private readonly db: TenantDb,
    private readonly keys: KeyRing,
  ) {}

  /** Tests stand in their own. */
  fetcher: typeof fetch = (...args) => fetch(...args);

  async tick(): Promise<number> {
    const due = await this.db.tx((tx) =>
      tx.logoutDelivery.findMany({
        where: { deliveredAt: null, failedAt: null, nextAttemptAt: { lte: new Date() } },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      }),
    );
    await Promise.all(due.map((d) => this.send(d)));
    return due.length;
  }

  private async send(d: Delivery): Promise<void> {
    const started = Date.now();
    let error: string | null = null;
    try {
      const token = await this.keys.sign(logoutClaims(d), {
        audience: d.clientId,
        ttlSeconds: TOKEN_TTL_SECONDS,
        type: 'logout+jwt',
      });
      const res = await this.fetcher(d.uri, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cache-control': 'no-cache',
          'user-agent': 'Landbright-Logout/1',
        },
        body: new URLSearchParams({ logout_token: token }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
      if (res.status !== 200 && res.status !== 204) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        error = `${res.status}${text ? ` ${text}` : ''}`;
      }
    } catch (e) {
      error = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
      error ||= 'no answer';
    }
    const attempts = d.attempts + 1;
    const data = {
      application: d.clientId,
      subject: d.subject,
      ...(d.sid && { sid: d.sid }),
      reason: d.reason,
      attempts,
    };
    await this.db.tx(async (tx) => {
      if (!error) {
        await tx.logoutDelivery.update({
          where: { id: d.id },
          data: { attempts, deliveredAt: new Date(), lastError: null },
        });
        await appendAudit(tx, this.db.tenantId, {
          actorId: null,
          actorLabel: LABEL,
          action: 'session.logout_sent',
          targetType: 'identity',
          targetId: d.subject,
          data: { ...data, ms: Date.now() - started },
        });
        return;
      }
      const giveUp = attempts >= MAX_ATTEMPTS;
      await tx.logoutDelivery.update({
        where: { id: d.id },
        data: {
          attempts,
          lastError: error.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + logoutRetryInMs(attempts)),
          ...(giveUp && { failedAt: new Date() }),
        },
      });
      // Recorded on the first failure (the application didn't take it) and when it is given up, not on every retry.
      if (attempts === 1 || giveUp)
        await appendAudit(tx, this.db.tenantId, {
          actorId: null,
          actorLabel: LABEL,
          action: 'session.logout_failed',
          targetType: 'identity',
          targetId: d.subject,
          data: { ...data, error: error.slice(0, 300), givenUp: giveUp },
        });
    });
  }
}
