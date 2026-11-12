import { describe, expect, it } from 'vitest';
import { HealthReport, overallStatus } from '../src';

describe('overallStatus', () => {
  it('is ok when every component is up', () => {
    expect(overallStatus([{ status: 'up' }, { status: 'up' }])).toBe('ok');
  });
  it('is degraded when some are down', () => {
    expect(overallStatus([{ status: 'up' }, { status: 'down' }])).toBe('degraded');
  });
  it('is down when all are down', () => {
    expect(overallStatus([{ status: 'down' }])).toBe('down');
  });
  it('is degraded when nothing is known', () => {
    expect(overallStatus([])).toBe('degraded');
  });
});

describe('HealthReport', () => {
  it('rejects a component without a target', () => {
    const result = HealthReport.safeParse({
      service: 'landbright-control',
      version: '0.1.0',
      environment: 'local',
      status: 'ok',
      checkedAt: new Date().toISOString(),
      components: [{ id: 'postgres', name: 'Postgres', kind: 'database', status: 'up', latencyMs: 2 }],
    });
    expect(result.success).toBe(false);
  });
});
