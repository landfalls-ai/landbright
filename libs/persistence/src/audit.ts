import { sha256 } from '@landbright/platform';
import type { Prisma } from '@prisma/client';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  /** Who did it: an identity, or nobody for the system itself. */
  actorId?: string | null;
  /** How the actor reads in the log: "Maya Cohen", "system", "Landflow (service)". */
  actorLabel: string;
  /** `identity.created`, `group.member_added`, `client.secret_rotated`, … */
  action: string;
  targetType: string;
  targetId?: string | null;
  data?: Record<string, unknown>;
}

export interface AuditRow extends Required<Omit<AuditInput, 'data'>> {
  tenantId: string;
  at: Date;
  data: unknown;
  prevHash: string;
  hash: string;
}

/** JSON with object keys sorted at every level, so the same event always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function auditHash(prevHash: string, row: Omit<AuditRow, 'prevHash' | 'hash'>): string {
  return sha256(
    `${prevHash}\n${canonical({
      tenantId: row.tenantId,
      at: row.at,
      actorId: row.actorId,
      actorLabel: row.actorLabel,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      data: row.data,
    })}`,
  );
}

/**
 * Appends one event to the tenant's chain, inside the caller's withTenant transaction, so the event commits if and
 * only if the change it records does. A transaction-scoped advisory lock per tenant keeps the chain linear when two
 * replicas write at once.
 */
export async function appendAudit(tx: Prisma.TransactionClient, tenantId: string, input: AuditInput): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`audit:${tenantId}`}, 0))`;
  const last = await tx.auditEvent.findFirst({ where: { tenantId }, orderBy: { id: 'desc' }, select: { hash: true } });
  const prevHash = last?.hash ?? GENESIS_HASH;
  const row = {
    tenantId,
    at: new Date(),
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    data: input.data ?? {},
  };
  await tx.auditEvent.create({
    data: { ...row, data: row.data as Prisma.InputJsonValue, prevHash, hash: auditHash(prevHash, row) },
  });
}

/**
 * Checks a run of consecutive events, oldest first: each links to the previous hash and its own hash matches its
 * content. Returns the id of the first event that fails, or undefined when the run is intact.
 */
export function verifyAuditChain(
  rows: Array<Omit<AuditRow, 'actorId' | 'targetId'> & { id: bigint; actorId: string | null; targetId: string | null }>,
  expectedFirstPrev?: string,
): bigint | undefined {
  let prev = expectedFirstPrev ?? rows[0]?.prevHash;
  for (const row of rows) {
    if (row.prevHash !== prev || auditHash(row.prevHash, row) !== row.hash) return row.id;
    prev = row.hash;
  }
  return undefined;
}
