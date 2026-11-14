import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { logs, SeverityNumber } from '@opentelemetry/api';

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  verbose: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  log: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

/**
 * Nest's console logger that also sends each line as an OpenTelemetry log record: severity, the Nest context (the
 * class that logged), an error's stack, and the trace and span of the request it belongs to (the SDK takes them from
 * the active context). Stdout is unchanged. Without a logger provider (no exporter configured, see startTelemetry)
 * the records go to OpenTelemetry's no-op logger.
 */
export class TelemetryLogger extends ConsoleLogger {
  private readonly otel = logs.getLogger('landbright');

  constructor(private readonly service: string) {
    super();
  }

  override log(message: unknown, ...rest: unknown[]): void {
    super.log(message, ...rest);
    this.emit('log', message, rest);
  }
  override warn(message: unknown, ...rest: unknown[]): void {
    super.warn(message, ...rest);
    this.emit('warn', message, rest);
  }
  override error(message: unknown, ...rest: unknown[]): void {
    super.error(message, ...rest);
    this.emit('error', message, rest);
  }
  override debug(message: unknown, ...rest: unknown[]): void {
    super.debug(message, ...rest);
    this.emit('debug', message, rest);
  }
  override verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(message, ...rest);
    this.emit('verbose', message, rest);
  }
  override fatal(message: unknown, ...rest: unknown[]): void {
    super.fatal(message, ...rest);
    this.emit('fatal', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]): void {
    if (!this.isLevelEnabled(level)) return;
    // Nest passes the context last (a string), and for errors a stack before it.
    const params = [...rest];
    const context = typeof params.at(-1) === 'string' && params.length > 0 ? String(params.pop()) : this.service;
    const stack = level === 'error' || level === 'fatal' ? params.find((p) => typeof p === 'string') : undefined;
    const error = message instanceof Error ? message : undefined;
    try {
      this.otel.emit({
        severityNumber: SEVERITY[level],
        severityText: level === 'log' ? 'INFO' : level.toUpperCase(),
        body: error ? error.message : typeof message === 'string' ? message : JSON.stringify(message),
        attributes: {
          'nest.context': context,
          ...(error && { 'exception.type': error.name }),
          ...((error?.stack ?? stack) && { 'exception.stacktrace': String(error?.stack ?? stack) }),
        },
      });
    } catch {
      // Telemetry never breaks logging.
    }
  }
}
