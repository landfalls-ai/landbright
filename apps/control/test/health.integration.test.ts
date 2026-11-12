import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthService } from '../src/health/health.service';
import { PersistenceModule } from '@landbright/persistence';
import { InfraModule } from '../src/common/infra.module';

/** Against the real compose stack (`pnpm dev:up`). Runs when LANDBRIGHT_INTEGRATION names `infra` (or is `all`). */
const flags = (process.env.LANDBRIGHT_INTEGRATION ?? '').split(',');
const enabled = flags.includes('infra') || flags.includes('all');

describe.skipIf(!enabled)('control health against the compose stack', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PersistenceModule, InfraModule],
      providers: [HealthService],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(() => app.close());

  it('finds Postgres, Valkey, OpenBao and Mailpit up', async () => {
    // Valkey connects asynchronously; give it a moment on a cold start.
    await new Promise((done) => setTimeout(done, 300));
    const report = await app.get(HealthService).report();
    const status = Object.fromEntries(report.components.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({ postgres: 'up', valkey: 'up', openbao: 'up', mailpit: 'up' });
  });
});
