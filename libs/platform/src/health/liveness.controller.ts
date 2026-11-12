import { Controller, Get, type Type } from '@nestjs/common';
import type { Liveness } from '@landbright/contracts';
import { Public } from '../auth/public.decorator';
import { serviceVersion } from '../config';

/**
 * `GET /healthz`: the process is up and serving. Says nothing about dependencies (that is control's `/api/health`),
 * so an orchestrator never restarts a healthy process because Postgres blinked.
 */
export function livenessController(service: Liveness['service']): Type<unknown> {
  @Controller()
  class LivenessController {
    // Public: liveness probes come from the orchestrator and the console's health page, with no session.
    @Public()
    @Get('healthz')
    healthz(): Liveness {
      return { status: 'ok', service, version: serviceVersion(), uptimeSeconds: Math.round(process.uptime()) };
    }
  }
  return LivenessController;
}
