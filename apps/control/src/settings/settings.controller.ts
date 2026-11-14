import { Body, ConflictException, Controller, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RotationResult, Settings, UpdateSignIn } from '@landbright/contracts';
import { type Config, issuerOf, passkeyRelyingParty } from '@landbright/platform';
import {
  appendAudit,
  CONFIG,
  PRISMA,
  type PrismaClient,
  rotateAfter,
  rotateSigningKeys,
  RotationTooSoon,
} from '@landbright/persistence';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Actor, audited, type Principal } from '../common/principal';
import { TenantDb } from '../common/tenant-db';

class SettingsDto extends createZodDto(Settings) {}
class UpdateSignInDto extends createZodDto(UpdateSignIn) {}
class RotationResultDto extends createZodDto(RotationResult) {}

@ApiTags('Settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly db: TenantDb,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  @Get()
  @ZodResponse({ type: SettingsDto })
  async get(@Actor() _actor: Principal): Promise<Settings> {
    const [tenant, keys] = await Promise.all([
      this.db.prisma.tenant.findUniqueOrThrow({ where: { id: this.db.tenantId } }),
      // Signing keys are deployment-wide (no tenant column); public parts only.
      this.db.prisma.signingKey.findMany({
        orderBy: { createdAt: 'desc' },
        select: { kid: true, alg: true, createdAt: true, retiredAt: true },
      }),
    ]);
    const ttl = this.config.LANDBRIGHT_ID_TOKEN_TTL_SECONDS;
    const published = keys.filter((k) => !k.retiredAt);
    const signing = published[0];
    return {
      tenant: { slug: tenant.slug, name: tenant.name },
      issuer: issuerOf(this.config),
      signIn: {
        mfaRequired: tenant.mfaRequired,
        // Passkeys need the issuer on a domain: WebAuthn refuses IP addresses.
        methods: passkeyRelyingParty(this.config) ? ['password', 'totp', 'passkey'] : ['password', 'totp'],
      },
      signingKeys: keys.map((k) => ({
        kid: k.kid,
        alg: k.alg,
        status: k.retiredAt ? 'retired' : k.kid === signing?.kid ? 'signing' : 'verifying',
        createdAt: k.createdAt.toISOString(),
        retiredAt: k.retiredAt?.toISOString() ?? null,
      })),
      idTokenTtlSeconds: ttl,
      rotateAfter: rotateAfter(published, ttl)?.toISOString() ?? null,
    };
  }

  @Patch('sign-in')
  @ApiOperation({
    summary:
      'Require (or stop requiring) a second step for everyone. People without one set it up at their next sign-in.',
  })
  @ZodResponse({ type: SettingsDto })
  async updateSignIn(@Body() body: UpdateSignInDto, @Actor() actor: Principal): Promise<Settings> {
    await this.db.tx(async (tx) => {
      await tx.tenant.update({ where: { id: this.db.tenantId }, data: { mfaRequired: body.mfaRequired } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'tenant.sign_in_changed',
        targetType: 'tenant',
        targetId: this.db.tenantId,
        data: { mfaRequired: body.mfaRequired },
      });
    });
    return this.get(actor);
  }

  @Post('signing-keys/rotate')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Rotate the signing keys: a new key signs from now on, the one it replaces stays published so its ID tokens still verify, older keys are retired. 409 while the replaced key could still have tokens in use.',
  })
  @ZodResponse({ type: RotationResultDto })
  async rotate(@Actor() actor: Principal): Promise<RotationResult> {
    let result: { kid: string; retired: string[] };
    try {
      // Keys are deployment-wide, outside row-level security (the identity plane reads them before any tenant).
      result = await rotateSigningKeys(
        this.prisma,
        this.config.LANDBRIGHT_SECRET_KEY,
        this.config.LANDBRIGHT_ID_TOKEN_TTL_SECONDS,
      );
    } catch (error) {
      if (error instanceof RotationTooSoon) throw new ConflictException(error.message);
      throw error;
    }
    await this.db.tx((tx) =>
      appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'signing_key.rotated',
        targetType: 'signing_key',
        targetId: result.kid,
        data: { kid: result.kid, retired: result.retired },
      }),
    );
    return { ...result, settings: await this.get(actor) };
  }
}
