import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe, probeHttp, PROBE_TIMEOUT_MS } from '../src/health/probes';

const what = { id: 'thing', name: 'Thing', kind: 'service' as const, target: '127.0.0.1:1' };

describe('probe', () => {
  it('reports up with the detail the check returned', async () => {
    const row = await probe(what, async () => 'v1.2.3');
    expect(row).toMatchObject({ id: 'thing', status: 'up', detail: 'v1.2.3' });
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports down with the reason when the check throws', async () => {
    const row = await probe(what, async () => {
      throw new Error('boom');
    });
    expect(row).toMatchObject({ status: 'down', detail: 'boom' });
  });

  it(
    'gives up after the timeout',
    async () => {
      const row = await probe(what, () => new Promise(() => undefined));
      expect(row).toMatchObject({ status: 'down', detail: `no answer in ${PROBE_TIMEOUT_MS} ms` });
    },
    PROBE_TIMEOUT_MS + 1000,
  );
});

describe('probeHttp', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '2.0.0' }));
      } else {
        res.statusCode = 503;
        res.end();
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('is up on 2xx and describes the body', async () => {
    const row = await probeHttp(what, `${base}/ok`, (body) => `v${(body as { version: string }).version}`);
    expect(row).toMatchObject({ status: 'up', detail: 'v2.0.0' });
  });

  it('is down on a non-2xx status', async () => {
    expect(await probeHttp(what, `${base}/bad`)).toMatchObject({ status: 'down', detail: 'HTTP 503' });
  });

  it('says "connection refused" when nothing listens', async () => {
    // A port that was free a moment ago: listen on 0, note the port, close.
    const spare = createServer();
    await new Promise<void>((done) => spare.listen(0, '127.0.0.1', done));
    const { port } = spare.address() as AddressInfo;
    await new Promise<void>((done) => spare.close(() => done()));
    expect(await probeHttp(what, `http://127.0.0.1:${port}/`)).toMatchObject({
      status: 'down',
      detail: 'connection refused',
    });
  });
});
