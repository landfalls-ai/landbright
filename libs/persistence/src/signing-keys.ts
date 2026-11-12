import { createHash, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { seal, unseal } from '@landbright/platform';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The issuer's signing keys, deployment-wide (no tenant column). Every key not retired is published in the JWKS; the
 * newest signs. A rotation adds a key, which signs from then on, and retires the keys older than the one it replaces,
 * so at most two are published: the one that signs, and the one that still verifies the ID tokens it signed. The
 * private halves are sealed with LANDBRIGHT_SECRET_KEY.
 */
export interface SigningJwk extends JsonWebKey {
  kid: string;
  alg: string;
  use: 'sig';
}

const LOCK = 'landbright:signing-keys';

/**
 * The keys to publish, newest first (oidc-provider signs with the first). When there is none, one RSA 2048 key
 * (RS256, which every relying party verifies) is generated, under an advisory lock so two replicas starting together
 * agree on one key.
 */
export async function loadSigningKeys(prisma: PrismaClient, secretKey: string): Promise<SigningJwk[]> {
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    const keys = await usableKeys(tx, secretKey);
    if (keys.length > 0) return keys;
    return [await createKey(tx, secretKey)];
  });
}

/** What the published key set looks like now: the identity plane reloads its provider when this changes. */
export async function signingKeyFingerprint(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.signingKey.findMany({
    where: { retiredAt: null },
    orderBy: { createdAt: 'desc' },
    select: { kid: true },
  });
  return rows.map((r) => r.kid).join(',');
}

/**
 * When the next rotation may happen, or null for now. A rotation retires the keys older than the one signing now; the
 * newest of those stopped signing when the current key was made, and ID tokens it signed live `idTokenTtlSeconds`
 * after that. So while such a key is published, wait until then.
 */
export function rotateAfter(
  published: Array<{ createdAt: Date }>,
  idTokenTtlSeconds: number,
  now = new Date(),
): Date | null {
  const [current, ...older] = [...published].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (!current || older.length === 0) return null;
  const after = new Date(current.createdAt.getTime() + idTokenTtlSeconds * 1000);
  return after > now ? after : null;
}

export class RotationTooSoon extends Error {
  constructor(readonly after: Date) {
    super(`The previous signing key still verifies ID tokens until ${after.toISOString()}. Rotate after that.`);
  }
}

/**
 * Rotates: a new key signs from now on, the key it replaces stays published, older ones are retired. Throws
 * RotationTooSoon when that would retire a key whose ID tokens may still be in use.
 */
export async function rotateSigningKeys(
  prisma: PrismaClient,
  secretKey: string,
  idTokenTtlSeconds: number,
  now = new Date(),
): Promise<{ kid: string; retired: string[] }> {
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    const published = await tx.signingKey.findMany({
      where: { retiredAt: null },
      orderBy: { createdAt: 'desc' },
      select: { kid: true, createdAt: true },
    });
    const after = rotateAfter(published, idTokenTtlSeconds, now);
    if (after) throw new RotationTooSoon(after);
    const retired = published.slice(1).map((k) => k.kid);
    if (retired.length > 0)
      await tx.signingKey.updateMany({ where: { kid: { in: retired } }, data: { retiredAt: now } });
    const created = await createKey(tx, secretKey, now);
    return { kid: created.kid, retired };
  });
}

async function lock(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`;
}

async function usableKeys(tx: Prisma.TransactionClient, secretKey: string): Promise<SigningJwk[]> {
  const rows = await tx.signingKey.findMany({ where: { retiredAt: null }, orderBy: { createdAt: 'desc' } });
  return rows.flatMap((row) => {
    try {
      const jwk = JSON.parse(unseal(secretKey, row.sealedPrivateJwk)) as JsonWebKey;
      return [{ ...jwk, kid: row.kid, alg: row.alg, use: 'sig' as const }];
    } catch {
      // Sealed under another LANDBRIGHT_SECRET_KEY: unusable here, left for an operator to retire.
      return [];
    }
  });
}

async function createKey(tx: Prisma.TransactionClient, secretKey: string, now = new Date()): Promise<SigningJwk> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(`${jwk.n}`).digest('base64url').slice(0, 16);
  const alg = 'RS256';
  const { kty, n, e } = jwk;
  await tx.signingKey.create({
    data: {
      kid,
      alg,
      publicJwk: { kty, n, e, kid, alg, use: 'sig' },
      sealedPrivateJwk: seal(secretKey, JSON.stringify(jwk)),
      createdAt: now,
    },
  });
  return { ...jwk, kid, alg, use: 'sig' };
}
