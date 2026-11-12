import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuditPage } from '@landbright/contracts';
import { verifyAuditChain } from '@landbright/persistence';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Actor, type Principal } from '../common/principal';
import { TenantDb } from '../common/tenant-db';

class AuditPageDto extends createZodDto(AuditPage) {}

@ApiTags('Audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly db: TenantDb) {}

  @Get()
  @ApiOperation({
    summary: 'The audit log, newest first, with a check that the page’s events chain up and match their hashes.',
  })
  @ApiQuery({ name: 'before', required: false, description: 'Events older than this id (a page’s nextBefore).' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 200; 50 by default.' })
  @ZodResponse({ type: AuditPageDto })
  async page(
    @Actor() _actor: Principal,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditPage> {
    if (before !== undefined && !/^\d{1,19}$/.test(before))
      throw new BadRequestException('before must be an event id.');
    const take = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200);
    const rows = await this.db.tx((tx) =>
      tx.auditEvent.findMany({
        where: before ? { id: { lt: BigInt(before) } } : {},
        orderBy: { id: 'desc' },
        take: take + 1,
      }),
    );
    const page = rows.slice(0, take);
    return {
      items: page.map((r) => ({
        id: r.id.toString(),
        at: r.at.toISOString(),
        actorId: r.actorId,
        actorLabel: r.actorLabel,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        data: (r.data ?? {}) as Record<string, unknown>,
        hash: r.hash,
      })),
      nextBefore: rows.length > take ? page[page.length - 1]!.id.toString() : null,
      // The extra, older row lets the oldest event on this page be checked against its predecessor too.
      chainIntact: verifyAuditChain([...rows].reverse()) === undefined,
    };
  }
}
