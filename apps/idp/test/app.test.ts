import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Liveness } from '@landbright/contracts';
import { DefaultDenyGuard } from '@landbright/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

describe('idp', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalGuards(new DefaultDenyGuard(app.get(Reflector)));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(() => app.close());

  it('answers liveness without a session', async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(Liveness.parse(await response.json()).service).toBe('landbright-idp');
  });

  it('serves nothing else yet', async () => {
    expect((await fetch(`${base}/.well-known/openid-configuration`)).status).toBe(404);
  });
});
