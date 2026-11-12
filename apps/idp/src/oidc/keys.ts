import { createHash, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { seal, unseal } from '@landbright/platform';
import type { Prisma, PrismaClient } from '@landbright/persistence';

export interface SigningJwk extends JsonWebKey {
  kid: string;
  alg: string;
  use: 'sig';
}

/**
 * The issuer's signing keys: every key not retired whose sealed private half opens with LANDBRIGHT_SECRET_KEY, newest
 * first (oidc-provider signs with the first and publishes all). When there is none, one RSA 2048 key (RS256, which
 * every relying party verifies) is generated and stored, under an advisory lock so two replicas starting together
 * agree on one key.
 */
export async function loadSigningKeys(prisma: PrismaClient, secretKey: string): Promise<SigningJwk[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('landbright:signing-keys', 0))`;
    const keys = await usableKeys(tx, secretKey);
    if (keys.length > 0) return keys;
    return [await createKey(tx, secretKey)];
  });
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

async function createKey(tx: Prisma.TransactionClient, secretKey: string): Promise<SigningJwk> {
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
    },
  });
  return { ...jwk, kid, alg, use: 'sig' };
}
