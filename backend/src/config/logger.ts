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

  if (isDevelopment) {
    // Development: Pretty printed logs with colors
    return pino({
      level,
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
  return pino({
    level,
  })
}

// Track if console overrides have been set up to avoid duplicate setup
let consoleOverridesSetup = false

/**
 * Format console arguments into a string (similar to console.log behavior)
 */
const formatConsoleArgs = (args: unknown[]): string => {
  if (args.length === 0) {
    return ''
  }
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg, null, 2)
        } catch {
          return String(arg)
        }
      }
      return String(arg)
    })
    .join(' ')
}

/**
 * Create a console override function that routes to a pino logger method
 */
const createConsoleOverride = (logger: Logger, method: 'info' | 'error' | 'warn' | 'debug') => {
  return (...args: unknown[]) => {
    const message = formatConsoleArgs(args)
    logger[method](message)
  }
}

/**
 * Override console methods to use pino logger
 * This ensures all console.* calls go through pino-pretty formatting
 * Only sets up once to avoid duplicate overrides
 */
const setupConsoleOverrides = (logger: Logger) => {
  // Only set up once
  if (consoleOverridesSetup) {
    return
  }
  consoleOverridesSetup = true

  // Override console methods to use pino logger
  // eslint-disable-next-line no-console
  console.log = createConsoleOverride(logger, 'info')
  // eslint-disable-next-line no-console
  console.error = createConsoleOverride(logger, 'error')
  // eslint-disable-next-line no-console
  console.warn = createConsoleOverride(logger, 'warn')
  // eslint-disable-next-line no-console
  console.info = createConsoleOverride(logger, 'info')
  // eslint-disable-next-line no-console
  if (console.debug) {
    // eslint-disable-next-line no-console
    console.debug = createConsoleOverride(logger, 'debug')
  }
}

/**
 * Minimal logger middleware: only decorates ctx.log with pino
 */
const createLoggerMiddleware = (settings: Settings) => {
  const logger = createPinoLogger(settings)
  // Override console methods to use pino logger
  setupConsoleOverrides(logger)
  return new Elysia({ name: 'logger' }).decorate('log', logger)
}

/**
 * Create a standalone logger instance for use outside request contexts
 * Also sets up console overrides so console.* calls go through pino
 */
const createStandaloneLogger = (settings: Settings): Logger => {
  const logger = createPinoLogger(settings)
  // Override console methods to use pino logger
  setupConsoleOverrides(logger)
  return logger
}

export { createLoggerMiddleware, createPinoLogger, createStandaloneLogger }
