import { Elysia } from 'elysia'
import { pino, type Logger } from 'pino'
import type { Settings } from './settings'

/**
 * Map our log levels to Pino's log levels
 */
const getLogLevel = (level: Settings['logLevel']): 'debug' | 'info' | 'warn' | 'error' => {
  switch (level) {
    case 'DEBUG':
      return 'debug'
    case 'INFO':
      return 'info'
    case 'WARN':
      return 'warn'
    case 'ERROR':
      return 'error'
    default:
      return 'info'
  }
}

/**
 * Create a Pino logger instance
 */
const createPinoLogger = (settings: Settings): Logger => {
  const isDevelopment = process.env.NODE_ENV !== 'production'
  const level = getLogLevel(settings.logLevel)

  const redact = {
    paths: [
      'authorization',
      'upstreamAuth',
      'apiKey',
      'req.headers.authorization',
      '*.authorization',
      '*.upstreamAuth',
      '*.apiKey',
    ],
    censor: '[REDACTED]',
  }

  if (isDevelopment) {
    // Development: Pretty printed logs with colors
    return pino({
      level,
      redact,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: false,
          ignore: 'pid,hostname,time',
        },
      },
    })
  }

  // Production: JSON structured logs
  return pino({ level, redact })
}

/**
 * Minimal logger middleware: only decorates ctx.log with pino
 */
const createLoggerMiddleware = (settings: Settings) => {
  const logger = createPinoLogger(settings)
  return new Elysia({ name: 'logger' }).decorate('log', logger)
}

/**
 * Create a standalone logger instance for use outside request contexts
 */
const createStandaloneLogger = (settings: Settings): Logger => {
  return createPinoLogger(settings)
}

export { createLoggerMiddleware, createPinoLogger, createStandaloneLogger }
