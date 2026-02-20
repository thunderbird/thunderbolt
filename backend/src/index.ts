import { createMainRoutes } from '@/api/routes'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { createGoogleAuthRoutes } from '@/auth/google'
import { createMicrosoftAuthRoutes } from '@/auth/microsoft'
import { createLoggerMiddleware, createStandaloneLogger } from '@/config/logger'
import { getCorsOriginsList, getSettings } from '@/config/settings'
import { createInferenceRoutes } from '@/inference/routes'
import { createErrorHandlingMiddleware } from '@/middleware/error-handling'
import { createHttpLoggingMiddleware } from '@/middleware/http-logging'
import { createWaitlistAuthMiddleware } from '@/middleware/waitlist-auth'
import { createPostHogRoutes } from '@/posthog/routes'
import { createProToolsRoutes } from '@/pro/routes'
import { createWaitlistRoutes } from '@/waitlist/routes'
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

  // Detect runtime and configure adapter
  const isBun = typeof Bun !== 'undefined'

  // Import Node adapter if running on Node.js
  const nodeAdapter = isBun ? undefined : (await import('@elysiajs/node')).node()

  const app = new Elysia({
    prefix: '/v1',
    ...(isBun ? {} : { adapter: nodeAdapter }),
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
      // Better Auth handler (mounted at /api/auth/*)
      .use(betterAuthPlugin)
      // Waitlist auth middleware - enforces auth on protected routes when WAITLIST_ENABLED=true
      .use(createWaitlistAuthMiddleware(settings, auth))
      // Tinfoil EHBP attestation endpoint
      // Proxies attestation bundle from Tinfoil to frontend
      // Errors are handled gracefully to prevent app startup failures
      .get('/attestation', async () => {
        try {
          // Add timeout to prevent hanging
          const ATTESTATION_TIMEOUT_MS = 10_000 // 10 seconds

          const response = await fetch('https://atc.tinfoil.sh/attestation', {
            signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
          })

          if (!response.ok) {
            console.error(`Tinfoil attestation returned status ${response.status}`)
            return new Response(JSON.stringify({ error: 'Failed to fetch attestation bundle' }), {
              status: response.status,
              headers: {
                'Content-Type': 'application/json',
              },
            })
          }

          const data = await response.json()

          return new Response(JSON.stringify(data), {
            status: response.status,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=300',
            },
          })
        } catch (error) {
          // Log error but return a response instead of throwing
          // This prevents attestation endpoint failures from crashing the app
          console.error('Tinfoil attestation fetch failed:', error)
          return new Response(
            JSON.stringify({
              error: 'Failed to fetch Tinfoil attestation bundle',
              message: error instanceof Error ? error.message : 'Unknown error',
            }),
            {
              status: 502,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          )
        }
      })
      // Mount route groups
      .use(createMainRoutes(fetchFn))
      .use(createGoogleAuthRoutes(fetchFn))
      .use(createMicrosoftAuthRoutes(fetchFn))
      .use(createProToolsRoutes(fetchFn))
      .use(createInferenceRoutes())
      .use(createPostHogRoutes(fetchFn))
      .use(createWaitlistRoutes({ database, auth, emailService: deps?.waitlistEmailService }))
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
    // Also log to console in case pino serialization fails
    console.error('Startup error details:', error)
    if (error instanceof Error) {
      console.error('Error message:', error.message)
      console.error('Error stack:', error.stack)
    }
    process.exit(1)
  }
}

// Start the server if this file is run directly
if (import.meta.main) {
  await import('dotenv/config')
  await startServer()
}

export { startServer }
