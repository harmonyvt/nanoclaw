/**
 * Effect service: Logger
 *
 * Bridges pino logging into an Effect service. Provides structured
 * logging that integrates with the existing multi-stream pino setup.
 */
import { Context, Effect, Layer, Logger, LogLevel } from 'effect';

import { logger as pinoLogger } from '../../logger.js';

export interface AppLogger {
  readonly debug: (module: string, msg: string, extra?: Record<string, unknown>) => void;
  readonly info: (module: string, msg: string, extra?: Record<string, unknown>) => void;
  readonly warn: (module: string, msg: string, extra?: Record<string, unknown>) => void;
  readonly error: (module: string, msg: string, extra?: Record<string, unknown>) => void;
  readonly pino: typeof pinoLogger;
}

export class AppLoggerService extends Context.Tag('nanoclaw/Logger')<
  AppLoggerService,
  AppLogger
>() {}

function makeLogger(): AppLogger {
  return {
    debug: (module, msg, extra) => pinoLogger.debug({ module, ...extra }, msg),
    info: (module, msg, extra) => pinoLogger.info({ module, ...extra }, msg),
    warn: (module, msg, extra) => pinoLogger.warn({ module, ...extra }, msg),
    error: (module, msg, extra) => pinoLogger.error({ module, ...extra }, msg),
    pino: pinoLogger,
  };
}

export const AppLoggerLive = Layer.succeed(AppLoggerService, makeLogger());

/**
 * Custom Effect Logger that bridges to pino.
 * This replaces Effect's default console logger with our pino setup.
 */
export const PinoLoggerLive = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ logLevel, message }) => {
    const msg = typeof message === 'string' ? message : String(message);
    switch (logLevel) {
      case LogLevel.Debug:
      case LogLevel.Trace:
        pinoLogger.debug({ module: 'effect' }, msg);
        break;
      case LogLevel.Info:
        pinoLogger.info({ module: 'effect' }, msg);
        break;
      case LogLevel.Warning:
        pinoLogger.warn({ module: 'effect' }, msg);
        break;
      case LogLevel.Error:
      case LogLevel.Fatal:
        pinoLogger.error({ module: 'effect' }, msg);
        break;
      default:
        pinoLogger.info({ module: 'effect' }, msg);
    }
  }),
);
