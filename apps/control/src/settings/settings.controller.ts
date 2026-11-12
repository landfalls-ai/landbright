import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Settings, UpdateSignIn } from '@landbright/contracts';
import { type Config, issuerOf } from '@landbright/platform';
import { appendAudit, CONFIG } from '@landbright/persistence';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Actor, audited, type Principal } from '../common/principal';
import { TenantDb } from '../common/tenant-db';

class SettingsDto extends createZodDto(Settings) {}
class UpdateSignInDto extends createZodDto(UpdateSignIn) {}

@ApiTags('Settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly db: TenantDb,
    @Inject(CONFIG) private readonly config: Config,
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
    return {
      tenant: { slug: tenant.slug, name: tenant.name },
      issuer: issuerOf(this.config),
      signIn: { mfaRequired: tenant.mfaRequired, methods: ['password', 'totp'] },
      signingKeys: keys.map((k) => ({
        kid: k.kid,
        alg: k.alg,
        createdAt: k.createdAt.toISOString(),
        retiredAt: k.retiredAt?.toISOString() ?? null,
      })),
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
}
