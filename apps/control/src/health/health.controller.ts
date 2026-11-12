import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthReport } from '@landbright/contracts';
import { Public } from '@landbright/platform';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { HealthService } from './health.service';

class HealthReportDto extends createZodDto(HealthReport) {}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Public for wave 0: the console shows it before sign-in exists. It reveals host:port and versions of local
  // dependencies only, never credentials. Wave 1 puts it behind an admin session (docs/limitations.md).
  @Public()
  @Get()
  @ApiOperation({ summary: 'Every dependency, probed now: identity plane, Postgres, Valkey, OpenBao, Mailpit.' })
  @ZodResponse({ type: HealthReportDto })
  report(): Promise<HealthReport> {
    return this.health.report();
  }
}
