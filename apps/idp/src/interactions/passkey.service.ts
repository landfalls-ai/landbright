import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Config, passkeyRelyingParty } from '@landbright/platform';
import {
  appendAudit,
  CONFIG,
  PRISMA,
  type PrismaClient,
  TENANT,
  type TenantRef,
  withTenant,
} from '@landbright/persistence';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Redis } from 'ioredis';
import { VALKEY } from '../valkey';

/** ES256, EdDSA, RS256: what platform authenticators and security keys use. */
const ALGORITHMS = [-7, -8, -257];
const CHALLENGE_TTL_SECONDS = 600;

export interface PasskeyOwner {
  identityId: string;
  email: string;
  displayName: string;
}

/**
 * Passkeys (WebAuthn) for sign-in. User verification is required, so a passkey is two factors: the device, and the
 * PIN or biometric that unlocks it. Each ceremony's challenge lives in Valkey under the interaction's uid and is
 * taken (GETDEL) when the response comes back, so a response works once.
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);
  private readonly rp: { id: string; origin: string } | undefined;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
    @Inject(CONFIG) config: Config,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {
    this.rp = passkeyRelyingParty(config);
  }

  /** False when the issuer's host is an IP address (WebAuthn refuses those). */
  get available(): boolean {
    return this.rp !== undefined;
  }

  /** Whether this person has a passkey (and passkeys are on). */
  async has(identityId: string): Promise<boolean> {
    if (!this.rp) return false;
    const found = await withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.credential.findFirst({ where: { identityId, kind: 'passkey' }, select: { id: true } }),
    );
    return Boolean(found);
  }

  /** Options for creating a passkey for this person. Their existing passkeys are excluded. */
  async registrationOptions(uid: string, owner: PasskeyOwner): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const rp = this.relyingParty();
    const existing = await this.credentials(owner.identityId);
    const options = await generateRegistrationOptions({
      rpName: 'Landbright',
      rpID: rp.id,
      userName: owner.email,
      userDisplayName: owner.displayName,
      userID: new TextEncoder().encode(owner.identityId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.externalId!, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    await this.saveChallenge(uid, options.challenge);
    return options;
  }

  /**
   * Options for signing in with a passkey: any of this person's (the second step), or any passkey at all when there is
   * no person yet (the sign-in page; the authenticator offers the ones it holds for this site).
   */
  async authenticationOptions(uid: string, identityId?: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const rp = this.relyingParty();
    const allow = identityId ? await this.credentials(identityId) : [];
    const options = await generateAuthenticationOptions({
      rpID: rp.id,
      userVerification: 'required',
      allowCredentials: allow.map((c) => ({ id: c.externalId!, transports: c.transports })),
    });
    await this.saveChallenge(uid, options.challenge);
    return options;
  }

  /** Verifies a new passkey and stores it. False when the response doesn't check out. */
  async register(uid: string, owner: PasskeyOwner, raw: string, label = 'Passkey'): Promise<boolean> {
    const rp = this.relyingParty();
    const challenge = await this.takeChallenge(uid);
    const response = parse<RegistrationResponseJSON>(raw);
    if (!challenge || !response) return false;
    let info;
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
      if (!result.verified) return false;
      info = result.registrationInfo;
    } catch (error) {
      this.logger.debug(`passkey registration refused: ${(error as Error).message}`);
      return false;
    }
    const tenantId = this.tenant.id;
    await withTenant(this.prisma, tenantId, async (tx) => {
      await tx.credential.create({
        data: {
          tenantId,
          identityId: owner.identityId,
          kind: 'passkey',
          label,
          secret: Buffer.from(info.credential.publicKey).toString('base64url'),
          externalId: info.credential.id,
          counter: BigInt(info.credential.counter),
          transports: info.credential.transports ?? [],
          lastUsedAt: new Date(),
        },
      });
      await appendAudit(tx, tenantId, {
        actorId: owner.identityId,
        actorLabel: owner.displayName,
        action: 'credential.passkey_added',
        targetType: 'identity',
        targetId: owner.identityId,
        data: { backedUp: info.credentialBackedUp, deviceType: info.credentialDeviceType },
      });
    });
    return true;
  }

  /**
   * Checks a passkey sign-in. With `identityId` (the second step) the passkey must be that person's. Returns who
   * signed in, or why not: `unknown` (no such passkey here, or its owner can't sign in) or `invalid` (the response
   * doesn't check out, or was already used), with the owner when there is one.
   */
  async authenticate(
    uid: string,
    raw: string,
    identityId?: string,
  ): Promise<{ ok: true; owner: PasskeyOwner } | { ok: false; reason: 'unknown' | 'invalid'; owner?: PasskeyOwner }> {
    const rp = this.relyingParty();
    const challenge = await this.takeChallenge(uid);
    const response = parse<AuthenticationResponseJSON>(raw);
    if (!response?.id) return { ok: false, reason: 'invalid' };
    const credential = await withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.credential.findFirst({
        where: { externalId: response.id, kind: 'passkey' },
        include: { identity: { select: { id: true, email: true, displayName: true, kind: true, status: true } } },
      }),
    );
    const identity = credential?.identity;
    if (!credential || !identity || identity.kind !== 'person' || identity.status !== 'active' || !identity.email)
      return { ok: false, reason: 'unknown' };
    const owner = { identityId: identity.id, email: identity.email, displayName: identity.displayName };
    if (identityId && identity.id !== identityId) return { ok: false, reason: 'unknown' };
    if (!challenge) return { ok: false, reason: 'invalid', owner };
    let newCounter: number;
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
        credential: {
          id: credential.externalId!,
          publicKey: Buffer.from(credential.secret, 'base64url'),
          counter: Number(credential.counter),
          transports: credential.transports as never,
        },
      });
      if (!result.verified) return { ok: false, reason: 'invalid', owner };
      newCounter = result.authenticationInfo.newCounter;
    } catch (error) {
      this.logger.debug(`passkey sign-in refused: ${(error as Error).message}`);
      return { ok: false, reason: 'invalid', owner };
    }
    // Conditional on the counter read above, so a cloned authenticator racing the real one can't both pass.
    const claimed = await withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.credential.updateMany({
        where: { id: credential.id, counter: credential.counter },
        data: { counter: BigInt(newCounter), lastUsedAt: new Date() },
      }),
    );
    if (claimed.count !== 1) return { ok: false, reason: 'invalid', owner };
    return { ok: true, owner };
  }

  private relyingParty(): { id: string; origin: string } {
    if (!this.rp) throw new Error('Passkeys need LANDBRIGHT_IDP_URL to be a domain, not an IP address');
    return this.rp;
  }

  private credentials(identityId: string) {
    return withTenant(this.prisma, this.tenant.id, (tx) =>
      tx.credential.findMany({
        where: { identityId, kind: 'passkey' },
        select: { externalId: true, transports: true },
      }),
    ).then((rows) => rows.map((r) => ({ ...r, transports: r.transports as never[] })));
  }

  private async saveChallenge(uid: string, challenge: string): Promise<void> {
    await this.valkey.set(`lb:webauthn:${uid}`, challenge, 'EX', CHALLENGE_TTL_SECONDS);
  }

  private async takeChallenge(uid: string): Promise<string | undefined> {
    return (await this.valkey.getdel(`lb:webauthn:${uid}`)) ?? undefined;
  }
}

function parse<T>(raw: string): T | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}
