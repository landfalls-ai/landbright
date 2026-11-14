import { logs, SeverityNumber } from '@opentelemetry/api';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { TelemetryLogger } from '../src/log-bridge';

describe('TelemetryLogger', () => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
  logs.setGlobalLoggerProvider(provider);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  afterAll(() => {
    vi.restoreAllMocks();
    logs.disable();
  });

  it('sends each line as a log record, with its severity and Nest context', async () => {
    const logger = new TelemetryLogger('landbright-test');
    logger.log('listening', 'Bootstrap');
    logger.warn('Valkey unavailable');
    logger.error('invite not sent', 'Error: smtp down\n    at x', 'PeopleService');
    await provider.forceFlush();
    const [info, warn, error] = exporter.getFinishedLogRecords();
    expect(info).toMatchObject({ body: 'listening', severityNumber: SeverityNumber.INFO, severityText: 'INFO' });
    expect(info!.attributes['nest.context']).toBe('Bootstrap');
    expect(warn).toMatchObject({ severityNumber: SeverityNumber.WARN });
    expect(warn!.attributes['nest.context']).toBe('landbright-test');
    expect(error).toMatchObject({ body: 'invite not sent', severityNumber: SeverityNumber.ERROR });
    expect(error!.attributes).toMatchObject({
      'nest.context': 'PeopleService',
      'exception.stacktrace': expect.stringContaining('smtp down'),
    });
  });
});
