import { createMainRoutes } from '@/api/routes'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { createGoogleAuthRoutes } from '@/auth/google'
import { createMicrosoftAuthRoutes } from '@/auth/microsoft'
import { createLoggerMiddleware, createStandaloneLogger } from '@/config/logger'
import { getCorsOrigins, getCorsOriginsList, getSettings } from '@/config/settings'
import { runMigrations } from '@/db/client'
import { createInferenceRoutes } from '@/inference/routes'
import { createErrorHandlingMiddleware } from '@/middleware/error-handling'
import { createHttpLoggingMiddleware } from '@/middleware/http-logging'
import { createWaitlistAuthMiddleware } from '@/middleware/waitlist-auth'
import { createMcpProxyRoutes } from '@/mcp-proxy/routes'
import { createPostHogRoutes } from '@/posthog/routes'
import { createProToolsRoutes } from '@/pro/routes'
import { createWaitlistRoutes } from '@/waitlist/routes'
import { createAccountRoutes } from '@/api/account'
import { createPowerSyncRoutes } from '@/api/powersync'
import type { AppDeps } from '@/types'
import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'

/**
 * Create the main Elysia application
 */
export const createApp = async (deps?: AppDeps) => {
  const fetchFn = deps?.fetchFn ?? globalThis.fetch
  const settings = getSettings()

  // Lazily import database to avoid initialization issues in tests/CI
  // where DATABASE_URL might not be set or circular dependencies might occur
  let database = deps?.database
  if (!database) {
    const { db } = await import('@/db/client')
    database = db
  }

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

  const { instrumentation } = await import('@/config/instrumentation')
  const configuredApp = instrumentation ? app.use(instrumentation) : app

  // Create auth plugin with the database instance
  const { plugin: betterAuthPlugin, auth } = createBetterAuthPlugin(database)

  return (
    configuredApp
      .use(
        cors({
          origin: getCorsOrigins(settings),
          credentials: settings.corsAllowCredentials,
          methods: settings.corsAllowMethods,
          allowedHeaders: settings.corsAllowHeaders,
          exposeHeaders: settings.corsExposeHeaders,
        }),
      )
      .use(createLoggerMiddleware(settings))
      .use(createHttpLoggingMiddleware())
      .use(createErrorHandlingMiddleware())
      // Better Auth handler (mounted at /api/auth/*)
      .use(betterAuthPlugin)
      // Waitlist auth middleware - enforces auth on protected routes when WAITLIST_ENABLED=true
      .use(createWaitlistAuthMiddleware(settings, auth))
      // Mount route groups
      .use(createMainRoutes(fetchFn))
      .use(createGoogleAuthRoutes(fetchFn))
      .use(createMicrosoftAuthRoutes(fetchFn))
      .use(createProToolsRoutes(auth, fetchFn))
      .use(createInferenceRoutes(auth))
      .use(createPostHogRoutes(fetchFn))
      .use(createMcpProxyRoutes(fetchFn, auth))
      .use(createWaitlistRoutes({ database, auth, emailService: deps?.waitlistEmailService }))
      .use(createPowerSyncRoutes(auth, settings, database))
      .use(createAccountRoutes(auth, database))
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
    // Run PGLite migrations before creating the app (no-op for Postgres)
    await runMigrations()

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

export { startServer }
