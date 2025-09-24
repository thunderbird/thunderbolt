import { pino, type Logger } from 'pino'
import { Elysia } from 'elysia'
import type { Settings } from './settings'

// Augment Elysia context with logger
declare module 'elysia' {
  interface Context {
    log: Logger
  }
}

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
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    })
  }

  // Production: JSON structured logs
  return pino({
    level,
  })
}

/**
 * Create logger middleware for Elysia based on @bogeychan/elysia-logger implementation
 */
const createLoggerMiddleware = (settings: Settings) => {
  const logger = createPinoLogger(settings)

  return new Elysia({ name: 'logger' })
    .decorate('log', logger)
    .onRequest((ctx) => {
      // Skip logging for health checks and static assets
      const url = new URL(ctx.request.url)
      if (url.pathname === '/health' || url.pathname.startsWith('/static/')) {
        return
      }

      // Add request start time for response time calculation
      ;(ctx as any)._startTime = Date.now()
    })
    .onAfterResponse((ctx) => {
      // Skip logging for health checks and static assets
      const url = new URL(ctx.request.url)
      if (url.pathname === '/health' || url.pathname.startsWith('/static/')) {
        return
      }

      const startTime = (ctx as any)._startTime
      const responseTime = startTime ? Date.now() - startTime : undefined

      logger.info({
        method: ctx.request.method,
        url: ctx.request.url,
        status: ctx.set.status || 200,
        responseTime,
        userAgent: ctx.request.headers.get('user-agent'),
      }, `${ctx.request.method} ${url.pathname}`)
    })
}

/**
 * Create a standalone logger instance for use outside request contexts
 */
const createStandaloneLogger = (settings: Settings): Logger => {
  return createPinoLogger(settings)
}

export { createLoggerMiddleware, createStandaloneLogger, createPinoLogger }