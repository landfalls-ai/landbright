import { Inject, Injectable } from '@nestjs/common';
import { type Config, issuerOf } from '@landbright/platform';
import { CONFIG, loadSigningKeys, PRISMA, type PrismaClient, type SigningJwk } from '@landbright/persistence';
import { createLocalJWKSet, importJWK, type JWTPayload, jwtVerify, SignJWT } from 'jose';

const REFRESH_MS = 60_000;

/**
 * The issuer's signing keys, as the control plane uses them: to sign event deliveries (so Landflow verifies them
 * against the issuer's JWKS, with no shared secret) and to check the access tokens services present on /api/v1. The
 * same keys the identity plane publishes, read from the database and refreshed every minute (a rotation shows up
 * within that).
 */
@Injectable()
export class KeyRing {
  private keys: SigningJwk[] = [];
  private loadedAt = 0;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  get issuer(): string {
    return issuerOf(this.config);
  }

  private async current(): Promise<SigningJwk[]> {
    if (this.keys.length === 0 || Date.now() - this.loadedAt > REFRESH_MS) {
      this.keys = await loadSigningKeys(this.prisma, this.config.LANDBRIGHT_SECRET_KEY);
      this.loadedAt = Date.now();
    }
    return this.keys;
  }

  /** Signs `claims` with the newest key, as the issuer. */
  async sign(claims: JWTPayload, options: { audience: string; ttlSeconds: number; type?: string }): Promise<string> {
    const [key] = await this.current();
    if (!key) throw new Error('No signing key');
    return new SignJWT(claims)
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: options.type ?? 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(options.audience)
      .setIssuedAt()
      .setExpirationTime(`${options.ttlSeconds}s`)
      .sign(await importJWK(key, key.alg));
  }

  /** Verifies a JWT the issuer signed for `audience`. */
  async verify(token: string, audience: string): Promise<JWTPayload> {
    const keys = (await this.current()).map(({ kty, n, e, kid, alg }) => ({ kty, n, e, kid, alg, use: 'sig' }));
    const jwks = createLocalJWKSet({ keys });
    try {
      return (await jwtVerify(token, jwks, { issuer: this.issuer, audience })).payload;
    } catch (error) {
      // A key rotated since the last refresh: reload once.
      this.loadedAt = 0;
      const fresh = (await this.current()).map(({ kty, n, e, kid, alg }) => ({ kty, n, e, kid, alg, use: 'sig' }));
      if (fresh.map((k) => k.kid).join() === keys.map((k) => k.kid).join()) throw error;
      return (await jwtVerify(token, createLocalJWKSet({ keys: fresh }), { issuer: this.issuer, audience })).payload;
    }
  }
}
