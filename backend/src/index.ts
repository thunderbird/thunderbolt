import { createMainRoutes } from '@/api/routes'
import { createGoogleAuthRoutes } from '@/auth/google'
import { createMicrosoftAuthRoutes } from '@/auth/microsoft'
import { instrumentation } from '@/config/instrumentation'
import { createLoggerMiddleware, createStandaloneLogger } from '@/config/logger'
import { getCorsOriginsList, getSettings } from '@/config/settings'
import { createErrorHandlingMiddleware } from '@/middleware/error-handling'
import { createHttpLoggingMiddleware } from '@/middleware/http-logging'
import { createOpenAIRoutes } from '@/openai/routes'
import { createPostHogRoutes } from '@/posthog/routes'
import { createProToolsRoutes } from '@/pro/routes'
import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'

/**
 * Create the main Elysia application
 */
const createApp = async (fetchFn: typeof fetch = globalThis.fetch) => {
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

  const configuredApp = instrumentation ? app.use(instrumentation) : app

  return (
    configuredApp
      .use(
        cors({
          origin: settings.corsOriginRegex ? new RegExp(settings.corsOriginRegex) : getCorsOriginsList(settings),
          credentials: settings.corsAllowCredentials,
          methods: settings.corsAllowMethods,
          allowedHeaders: settings.corsAllowHeaders,
          exposeHeaders: settings.corsExposeHeaders,
        }),
      )
      .use(createLoggerMiddleware(settings))
      .use(createHttpLoggingMiddleware())
      .use(createErrorHandlingMiddleware())
      // Mount route groups
      .use(createMainRoutes(fetchFn))
      .use(createGoogleAuthRoutes(fetchFn))
      .use(createMicrosoftAuthRoutes(fetchFn))
      .use(createProToolsRoutes(fetchFn))
      .use(createOpenAIRoutes())
      .use(createPostHogRoutes(fetchFn))
  )
}

/**
 * Start the server
 */
const startServer = async () => {
  const settings = getSettings()
  const log = createStandaloneLogger(settings)

  // Set up logging
  log.info('Starting Thunderbolt Server...')
  log.info(
    {
      logLevel: settings.logLevel,
      port: settings.port,
      corsOrigins: getCorsOriginsList(settings),
      nodeEnv: process.env.NODE_ENV,
    },
    'Server configuration',
  )

  try {
    const app = await createApp()

    const hostname = process.env.HOST
      ? process.env.HOST
      : process.env.NODE_ENV === 'production'
        ? '0.0.0.0'
        : 'localhost'

    app.listen(
      {
        hostname,
        port: settings.port,
        reusePort: process.env.NODE_ENV === 'production',
      },
      () => {
        log.info(
          {
            hostname,
            port: settings.port,
            url: `http://localhost:${settings.port}/v1`,
          },
          '🦊 Elysia server started',
        )

        if (process.env.NODE_ENV !== 'production') {
          log.info(
            {
              swaggerUrl: `http://localhost:${settings.port}/v1/swagger`,
            },
            '📚 Swagger documentation available',
          )
        }
      },
    )

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
