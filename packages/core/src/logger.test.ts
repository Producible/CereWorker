import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, configureLogger } from './logger.js';

describe('Logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    // Reset to default
    configureLogger({ level: 'info', stderr: false });
  });

  it('creates a logger with the given name', () => {
    const log = createLogger('test');
    expect(log).toBeDefined();
    expect(log.debug).toBeInstanceOf(Function);
    expect(log.info).toBeInstanceOf(Function);
    expect(log.warn).toBeInstanceOf(Function);
    expect(log.error).toBeInstanceOf(Function);
  });

  it('does not write to stderr in TUI mode (default)', () => {
    const log = createLogger('test');
    log.warn('warning message');
    log.error('error message');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('includes data in log entries when stderr enabled', () => {
    configureLogger({ level: 'info', stderr: true });
    const log = createLogger('test');
    log.error('failed', { code: 42, reason: 'timeout' });

    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.tz).toBe('UTC');
    expect(parsed.code).toBe(42);
    expect(parsed.reason).toBe('timeout');
  });

  it('filters debug messages at info level', () => {
    configureLogger({ level: 'info' });
    const log = createLogger('test');
    log.debug('should not appear');
    // debug doesn't write to stderr, and with no file stream it's silently dropped
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('shows debug messages at debug level', () => {
    configureLogger({ level: 'debug' });
    const log = createLogger('test');
    // debug still doesn't write to stderr (only warn/error do), but it should not throw
    log.debug('debug message');
    expect(stderrSpy).not.toHaveBeenCalled(); // debug never goes to stderr
  });

  it('filters info messages at warn level', () => {
    configureLogger({ level: 'warn' });
    const log = createLogger('test');
    log.info('should be filtered');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes all levels to stderr when stderr option is true', () => {
    configureLogger({ level: 'debug', stderr: true });
    const log = createLogger('test');
    log.debug('debug msg');
    log.info('info msg');
    log.warn('warn msg');
    log.error('error msg');
    expect(stderrSpy).toHaveBeenCalledTimes(4);

    const levels = stderrSpy.mock.calls.map((call) => JSON.parse((call[0] as string).trim()).level);
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('child logger includes parent name', () => {
    configureLogger({ level: 'info', stderr: true });
    const parent = createLogger('parent');
    const child = parent.child('child');
    child.error('child error');

    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.name).toBe('parent:child');
  });
});
