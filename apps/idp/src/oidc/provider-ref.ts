import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import type { Config } from '@landbright/platform';
import { loadSigningKeys, type PrismaClient, signingKeyFingerprint, type TenantRef } from '@landbright/persistence';
import type Provider from 'oidc-provider';
import { createProvider } from './provider';

/** How stale the published key set may get: a rotation reaches the JWKS and signing within this. */
const CHECK_EVERY_MS = 5_000;

/**
 * The OIDC provider, rebuilt when the published signing keys change (a rotation in the console). oidc-provider takes
 * its keys once, at construction, and keeps everything else in Postgres, so a fresh instance carries on where the old
 * one stopped. The check is on demand: at most one cheap query every five seconds, while requests come in, so every
 * replica follows without a message bus.
 */
export class OidcProviderRef {
  private readonly logger = new Logger('signing-keys');
  private provider!: Provider;
  private handler!: ReturnType<Provider['callback']>;
  private fingerprint = '';
  private checkedAt = 0;
  private checking: Promise<void> | undefined;

  private constructor(
    private readonly config: Config,
    private readonly prisma: PrismaClient,
    private readonly tenant: TenantRef,
  ) {}

  static async create(config: Config, prisma: PrismaClient, tenant: TenantRef): Promise<OidcProviderRef> {
    const ref = new OidcProviderRef(config, prisma, tenant);
    await ref.build();
    return ref;
  }

  /** The provider as of the last check. Call fresh() first where a stale key set matters. */
  get current(): Provider {
    return this.provider;
  }

  /** The provider, after checking the key set if the last check is older than five seconds. */
  async fresh(): Promise<Provider> {
    if (Date.now() - this.checkedAt >= CHECK_EVERY_MS) {
      this.checking ??= this.check().finally(() => (this.checking = undefined));
      await this.checking;
    }
    return this.provider;
  }

  /** Express middleware for /oidc. */
  readonly middleware = (req: IncomingMessage, res: ServerResponse): void => {
    this.fresh().then(
      () => void this.handler(req, res),
      (error: unknown) => {
        this.logger.error(`key check failed: ${(error as Error).message}`);
        // Serve with the keys we have: they were valid a moment ago.
        void this.handler(req, res);
      },
    );
  };

  private async check(): Promise<void> {
    const now = await signingKeyFingerprint(this.prisma);
    this.checkedAt = Date.now();
    if (now !== this.fingerprint) await this.build();
  }

  private async build(): Promise<void> {
    const keys = await loadSigningKeys(this.prisma, this.config.LANDBRIGHT_SECRET_KEY);
    const provider = createProvider(this.config, this.prisma, this.tenant, keys);
    const before = this.fingerprint;
    this.provider = provider;
    this.handler = provider.callback();
    this.fingerprint = await signingKeyFingerprint(this.prisma);
    this.checkedAt = Date.now();
    if (before) this.logger.log(`signing keys changed: ${keys.map((k) => k.kid).join(', ')} (the first signs)`);
  }
}
