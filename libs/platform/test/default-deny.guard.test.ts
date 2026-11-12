import 'reflect-metadata';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultDenyGuard } from '../src/auth/default-deny.guard';
import { Public } from '../src/auth/public.decorator';

@Controller()
class ProbeController {
  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }

  @Get('closed')
  closed() {
    return { ok: true };
  }
}

@Public()
@Controller('public-class')
class PublicController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe('DefaultDenyGuard', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController, PublicController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalGuards(new DefaultDenyGuard(app.get(Reflector)));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(() => app.close());

  it('lets a @Public() route through', async () => {
    expect((await fetch(`${base}/open`)).status).toBe(200);
  });

  it('lets a route of a @Public() controller through', async () => {
    expect((await fetch(`${base}/public-class`)).status).toBe(200);
  });

  it('denies every other route', async () => {
    expect((await fetch(`${base}/closed`)).status).toBe(401);
  });
});
