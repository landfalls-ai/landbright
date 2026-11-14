import type { Prisma } from '@prisma/client';

/**
 * OpenID Back-Channel Logout 1.0: when someone's session at Landbright ends, each application they signed in to
 * through it, if it has a `backchannel_logout_uri`, is owed a logout token. This queues them (in the caller's
 * transaction, with the change that ended the sessions); the control plane's event worker signs and sends them.
 */

export const LOGOUT_REASONS = ['signed_out', 'sessions_ended', 'deactivated'] as const;
export type LogoutReason = (typeof LOGOUT_REASONS)[number];

/** One logout owed: a subject at an application, for one session (`sid`) or, with null, for all of them. */
export interface OwedLogout {
  clientId: string;
  subject: string;
  sid: string | null;
}

interface SessionPayload {
  accountId?: string;
  authorizations?: Record<string, { sid?: string }>;
}

/** The (application, session) pairs of oidc-provider sessions, from their stored payloads. */
export function logoutsOfSessions(payloads: unknown[]): OwedLogout[] {
  return payloads.flatMap((p) => {
    const s = p as SessionPayload;
    if (!s.accountId) return [];
    return Object.entries(s.authorizations ?? {}).map(([clientId, a]) => ({
      clientId,
      subject: s.accountId!,
      sid: a?.sid ?? null,
    }));
  });
}

/**
 * Ends someone's oidc-provider sessions (all, or all but `keepId`), and queues the logouts they owe. Answers how many
 * sessions ended.
 */
export async function endSessionsOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  accountId: string,
  reason: LogoutReason,
  keepId?: string,
): Promise<{ ended: number; queued: number }> {
  const rows = keepId
    ? await tx.$queryRaw<Array<{ payload: unknown }>>`DELETE FROM oidc_payload WHERE type = 'Session'
        AND payload->>'accountId' = ${accountId} AND id <> ${keepId} RETURNING payload`
    : await tx.$queryRaw<Array<{ payload: unknown }>>`DELETE FROM oidc_payload WHERE type = 'Session'
        AND payload->>'accountId' = ${accountId} RETURNING payload`;
  const queued = await queueLogouts(tx, tenantId, logoutsOfSessions(rows.map((r) => r.payload)), reason);
  return { ended: rows.length, queued };
}

/**
 * Queues logouts to the applications that take them (a `backchannel_logout_uri`); the rest are dropped. Duplicates
 * (one application, one subject, one session) are queued once. Answers how many were queued.
 */
export async function queueLogouts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  owed: OwedLogout[],
  reason: LogoutReason,
): Promise<number> {
  if (owed.length === 0) return 0;
  const clients = await tx.oidcClient.findMany({
    where: { clientId: { in: [...new Set(owed.map((o) => o.clientId))] }, backchannelLogoutUri: { not: null } },
    select: { clientId: true, backchannelLogoutUri: true },
  });
  const uriOf = new Map(clients.map((c) => [c.clientId, c.backchannelLogoutUri!]));
  const seen = new Set<string>();
  const data = owed.flatMap((o) => {
    const uri = uriOf.get(o.clientId);
    const key = `${o.clientId}\n${o.subject}\n${o.sid ?? ''}`;
    if (!uri || seen.has(key)) return [];
    seen.add(key);
    return [{ tenantId, clientId: o.clientId, uri, subject: o.subject, sid: o.sid, reason }];
  });
  if (data.length) await tx.logoutDelivery.createMany({ data });
  return data.length;
}
