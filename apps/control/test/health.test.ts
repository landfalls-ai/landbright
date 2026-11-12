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
import { CONFIG, PG_POOL, VALKEY } from '../src/infra/infra.module';

/**
 * The health route end to end, with the infrastructure faked: Postgres and Valkey as in-memory stand-ins, the
 * identity plane, OpenBao and Mailpit as one local HTTP server. health.integration.test.ts runs against the real
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
      .overrideProvider(PG_POOL)
      .useValue({ query: async () => ({ rows: [{ server_version: '16.10 (Debian)' }] }), end: async () => undefined })
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
    const response = await fetch(`${base}/api/health`);
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
      const report = HealthReport.parse(await (await fetch(`${base}/api/health`)).json());
      expect(report.status).toBe('degraded');
      expect(report.components.find((c) => c.id === 'openbao')).toMatchObject({ status: 'down', detail: 'sealed' });
    } finally {
      openbaoSealed = false;
    }
  });

  it('never puts credentials in a target', async () => {
    const report = HealthReport.parse(await (await fetch(`${base}/api/health`)).json());
    expect(JSON.stringify(report)).not.toContain('landbright-dev-only');
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
    expect(Object.keys(document.paths)).toContain('/api/health');
  });
});
