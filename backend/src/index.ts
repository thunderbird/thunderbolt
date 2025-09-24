import { createGoogleAuthRoutes } from '@/auth/google'
import { createMicrosoftAuthRoutes } from '@/auth/microsoft'
import { createLoggerMiddleware, createStandaloneLogger } from '@/config/logger'
import { getCorsOriginsList, getSettings } from '@/config/settings'
import { createProToolsRoutes } from '@/pro/routes'
import { createFlowerRoutes } from '@/routes/flower'
import { createMainRoutes } from '@/routes/main'
import { createOpenAIRoutes } from '@/routes/openai'
import { createPostHogRoutes } from '@/routes/posthog'
import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'

/**
 * Create the main Elysia application
 */
const createApp = async () => {
  const settings = getSettings()

  const app = new Elysia({
    prefix: '/v1',
  })

  if (process.env.NODE_ENV !== 'production') {
    const { swagger } = await import('@elysiajs/swagger')
    app.use(
      swagger({
        documentation: {
          info: {
            title: 'Thunderbolt Backend',
            description: 'Backend for Thunderbolt',
            version: '0.1.0',
          },
        },
      }),
    )
  }

  return app
    .use(createLoggerMiddleware(settings))
    .use(
      cors({
        origin: settings.corsOriginRegex ? new RegExp(settings.corsOriginRegex) : getCorsOriginsList(settings),
        credentials: settings.corsAllowCredentials,
        methods: settings.corsAllowMethods,
        allowedHeaders: settings.corsAllowHeaders,
        exposeHeaders: settings.corsExposeHeaders,
      }),
    )
    .onError((ctx) => {
      const { code, error, set, request } = ctx
      const log = (ctx as any).log
      
      switch (code) {
        case 'VALIDATION':
          set.status = 400
          log?.warn({ error: error.message }, 'Validation failed')
          return {
            error: 'Validation failed',
            message: error.message,
          }
        case 'NOT_FOUND':
          set.status = 404
          log?.warn({ url: request.url }, 'Resource not found')
          return {
            error: 'Not found',
            message: 'The requested resource was not found',
          }
        default:
          // Handle custom HTTP errors
          if (error instanceof Error) {
            const status = (error as any).status || set.status || 500
            set.status = status

            if (status === 503) {
              log?.error({ error: error.message, stack: error.stack }, 'Service unavailable')
              return {
                error: 'Service unavailable',
                message: error.message,
              }
            }

            if (status === 401) {
              log?.warn({ error: error.message }, 'Unauthorized request')
              return {
                error: 'Unauthorized',
                message: error.message,
              }
            }

            if (status === 400) {
              log?.warn({ error: error.message }, 'Bad request')
              return {
                error: 'Bad request',
                message: error.message,
              }
            }

            log?.error({ error: error.message, stack: error.stack }, 'Unhandled request error')
          } else {
            log?.error({ error }, 'Non-Error exception thrown')
          }

          set.status = 500
          return {
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'An unexpected error occurred',
          }
      }
    })
    // Mount route groups
    .use(createMainRoutes())
    .use(createGoogleAuthRoutes())
    .use(createMicrosoftAuthRoutes())
    .use(createProToolsRoutes())
    .use(createOpenAIRoutes())
    .use(createPostHogRoutes())
    .use(createFlowerRoutes())
}

/**
 * Start the server
 */
const startServer = async () => {
  const settings = getSettings()
  const log = createStandaloneLogger(settings)

  // Set up logging
  log.info('Starting Thunderbolt Backend (Elysia)...')
  log.info({
    logLevel: settings.logLevel,
    port: settings.port,
    corsOrigins: getCorsOriginsList(settings),
    nodeEnv: process.env.NODE_ENV,
  }, 'Server configuration')

  try {
    const app = await createApp()

    const hostname = process.env.HOST ? process.env.HOST : process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost'
    
    app.listen({
      hostname,
      port: settings.port,
      reusePort: true,
    }, () => {
      log.info({
        hostname,
        port: settings.port,
        url: `http://localhost:${settings.port}`,
      }, '🦊 Elysia server started')

      if (process.env.NODE_ENV !== 'production') {
        log.info({
          swaggerUrl: `http://localhost:${settings.port}/swagger`,
        }, '📚 Swagger documentation available')
      }
    })

    // Graceful shutdown
    process.on('SIGINT', async () => {
      log.info('Received SIGINT, shutting down gracefully...')
      process.exit(0)
    })

    process.on('SIGTERM', async () => {
      log.info('Received SIGTERM, shutting down gracefully...')
      process.exit(0)
    })
  } catch (error) {
    log.error({ error }, 'Failed to start server')
    process.exit(1)
  }
}

// Start the server if this file is run directly
if (import.meta.main) {
  startServer()
}

export { createApp, startServer }
