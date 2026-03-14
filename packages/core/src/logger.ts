export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(name: string): Logger;
}

let globalLevel: LogLevel = 'info';
let logFile: string | undefined;
let writeStream: { write(s: string): void } | null = null;
let stderrAll = false;

export function configureLogger(options: { level?: LogLevel; file?: string; stderr?: boolean }): void {
  if (options.level) globalLevel = options.level;
  if (options.stderr !== undefined) stderrAll = options.stderr;
  if (options.file) {
    logFile = options.file;
    // Lazy import to avoid top-level side effects
    import('node:fs').then(({ createWriteStream }) => {
      writeStream = createWriteStream(logFile!, { flags: 'a' });
    });
  }
}

function formatEntry(level: LogLevel, name: string, msg: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const base = { ts, level, name, msg, ...data };
  return JSON.stringify(base);
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[globalLevel];
}

function writeLog(level: LogLevel, name: string, msg: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const entry = formatEntry(level, name, msg, data);
  if (writeStream) {
    writeStream.write(entry + '\n');
  }
  // Also write to stderr (all levels in headless mode, warn/error only in TUI mode)
  if (stderrAll || level === 'error' || level === 'warn') {
    process.stderr.write(entry + '\n');
  }
}

export function createLogger(name: string): Logger {
  return {
    debug: (msg, data) => writeLog('debug', name, msg, data),
    info: (msg, data) => writeLog('info', name, msg, data),
    warn: (msg, data) => writeLog('warn', name, msg, data),
    error: (msg, data) => writeLog('error', name, msg, data),
    child: (childName) => createLogger(`${name}:${childName}`),
  };
}
