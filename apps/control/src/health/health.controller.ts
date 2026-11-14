import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthReport } from '@landbright/contracts';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Actor, type Principal } from '../common/principal';
import { HealthService } from './health.service';

class HealthReportDto extends createZodDto(HealthReport) {}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Administrators only: it shows local addresses and dependency versions. Liveness (/healthz) stays public.
  @Get()
  @ApiOperation({ summary: 'Every dependency, probed now: identity plane, Postgres, Valkey, OpenBao, Mailpit.' })
  @ZodResponse({ type: HealthReportDto })
  report(@Actor() _actor: Principal): Promise<HealthReport> {
    return this.health.report();
  }
}
