import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { HealthReport } from '@landbright/contracts';
import { type Config, DefaultDenyGuard, loadConfig } from '@landbright/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureControl } from '../src/configure';
import { CONFIG, PRISMA, TENANT } from '@landbright/persistence';
import type { NextFunction, Request, Response } from 'express';
import { SessionMiddleware } from '../src/auth/session.middleware';
import type { WithPrincipal } from '../src/common/principal';
import { VALKEY } from '../src/common/tokens';

const ADMIN = {
  kind: 'person' as const,
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'Administrator',
  email: 'admin@landbright.test',
  admin: true,
  sessionId: 's',
};
/** Stands in for the session cookie: `lb_session=admin` signs in as an administrator. */
const fakeSessions = {
  use(req: Request & WithPrincipal, _res: Response, next: NextFunction) {
    if (/(^|; )lb_session=admin(;|$)/.test(req.headers.cookie ?? '')) req.principal = ADMIN;
    next();
  },
};
const asAdmin = { headers: { cookie: 'lb_session=admin' } };

/**
 * The health route end to end, with the infrastructure faked: Postgres, Valkey and the session as in-memory
 * stand-ins, the identity plane, OpenBao and Mailpit as one local HTTP server. health.integration.test.ts runs against the real
 * compose stack.
 */
describe('control: GET /api/health', () => {
  let app: INestApplication;
  let fakes: Server;
  let base: string;
  let openbaoSealed = false;

  beforeAll(async () => {
    fakes = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/healthz') {
        res.end(JSON.stringify({ status: 'ok', service: 'landbright-idp', version: '0.1.0', uptimeSeconds: 3 }));
      } else if (req.url === '/v1/sys/health') {
        res.end(JSON.stringify({ initialized: true, sealed: openbaoSealed, version: '2.4.1' }));
      } else if (req.url === '/api/v1/info') {
        res.end(JSON.stringify({ Version: 'v1.33.1' }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((done) => fakes.listen(0, '127.0.0.1', done));
    const fakeUrl = `http://127.0.0.1:${(fakes.address() as AddressInfo).port}`;

    const config: Config = {
      ...loadConfig({}),
      LANDBRIGHT_IDP_URL: fakeUrl,
      LANDBRIGHT_OPENBAO_ADDR: fakeUrl,
      LANDBRIGHT_MAILPIT_URL: fakeUrl,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG)
      .useValue(config)
      .overrideProvider(PRISMA)
      .useValue({ $queryRaw: async () => [{ server_version: '16.10 (Debian)' }], $disconnect: async () => undefined })
      .overrideProvider(TENANT)
      .useValue({ id: '00000000-0000-4000-8000-0000000000aa', slug: 'local', name: 'Local' })
      .overrideProvider(SessionMiddleware)
      .useValue(fakeSessions)
      .overrideProvider(VALKEY)
      .useValue({
        status: 'ready',
        ping: async () => 'PONG',
        info: async () => '# Server\r\nvalkey_version:8.1.4\r\n',
        disconnect: () => undefined,
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalGuards(new DefaultDenyGuard(app.get(Reflector)));
    configureControl(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((done) => fakes.close(() => done()));
  });

  it('reports every dependency up, with versions', async () => {
    const response = await fetch(`${base}/api/health`, asAdmin);
    expect(response.status).toBe(200);
    const report = HealthReport.parse(await response.json());
    expect(report.status).toBe('ok');
    expect(Object.fromEntries(report.components.map((c) => [c.id, c.detail]))).toEqual({
      idp: 'landbright-idp 0.1.0',
      postgres: 'PostgreSQL 16.10',
      valkey: 'Valkey 8.1.4',
      openbao: 'OpenBao 2.4.1',
      mailpit: 'Mailpit v1.33.1',
    });
  });

  it('is degraded when one dependency is down, and says why', async () => {
    openbaoSealed = true;
    try {
      const report = HealthReport.parse(await (await fetch(`${base}/api/health`, asAdmin)).json());
      expect(report.status).toBe('degraded');
      expect(report.components.find((c) => c.id === 'openbao')).toMatchObject({ status: 'down', detail: 'sealed' });
    } finally {
      openbaoSealed = false;
    }
  });

  it('never puts credentials in a target', async () => {
    const report = HealthReport.parse(await (await fetch(`${base}/api/health`, asAdmin)).json());
    expect(JSON.stringify(report)).not.toContain('landbright-dev-only');
  });

  it('is for administrators only', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
  });

  it('refuses writes from another origin', async () => {
    const response = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { ...asAdmin.headers, origin: 'http://127.0.0.1:3000' },
    });
    expect(response.status).toBe(403);
  });

  it('says who is signed in', async () => {
    expect(await (await fetch(`${base}/api/auth/me`, asAdmin)).json()).toMatchObject({
      email: 'admin@landbright.test',
      admin: true,
      tenant: { slug: 'local' },
    });
    expect((await fetch(`${base}/api/auth/me`)).status).toBe(401);
  });

  it('keeps liveness at /healthz, outside the /api prefix', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('publishes the OpenAPI document with the health contract', async () => {
    const document = (await (await fetch(`${base}/api/openapi.json`)).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/health',
        '/api/people',
        '/api/groups/{id}/members',
        '/api/applications',
        '/api/audit',
      ]),
    );
  });
});
