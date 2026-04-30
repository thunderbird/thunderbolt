/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMainRoutes } from '@/api/routes'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { createGoogleAuthRoutes } from '@/auth/google'
import { createMicrosoftAuthRoutes } from '@/auth/microsoft'
import { createOidcConfigRoutes } from '@/auth/oidc'
import { createLoggerMiddleware, createPinoLogger, createStandaloneLogger } from '@/config/logger'
import { getCorsOriginsList, getSettings } from '@/config/settings'
import { runMigrations } from '@/db/client'
import { createInferenceRoutes } from '@/inference/routes'
import { createErrorHandlingMiddleware } from '@/middleware/error-handling'
import { createHttpLoggingMiddleware } from '@/middleware/http-logging'
import { createAuthIpRateLimit, createInferenceRateLimit, createProRateLimit } from '@/middleware/rate-limit'
import { createMcpProxyRoutes } from '@/mcp-proxy/routes'
import { createProxyObserver } from '@/proxy/observability'
import { createUniversalProxyRoutes } from '@/proxy/routes'
import { getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { createPostHogRoutes } from '@/posthog/routes'
import { createProToolsRoutes } from '@/pro/routes'
import { createWaitlistRoutes } from '@/waitlist/routes'
import { createAccountRoutes } from '@/api/account'
import { createConfigRoutes } from '@/api/config'
import { createEncryptionRoutes } from '@/api/encryption'
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

  if (settings.swaggerEnabled) {
    // Lazy import to avoid loading swagger and its transitive deps in production
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

  const rateLimitSettings = { enabled: settings.rateLimitEnabled }
  const ipRateLimitSettings = { ...rateLimitSettings, trustedProxy: settings.trustedProxy }

  // Create auth plugin with the database instance (tests may inject their own auth)
  const { plugin: betterAuthPlugin, auth: createdAuth } = createBetterAuthPlugin(
    database,
    createAuthIpRateLimit(database, ipRateLimitSettings),
  )
  const auth = deps?.auth ?? createdAuth

  // Build the proxy observer once — wired to the production logger and
  // (when configured) PostHog. Tests inject their own observer via createApp deps.
  const proxyObserver =
    deps?.proxyObserver ??
    createProxyObserver({
      logger: createPinoLogger(settings),
      posthog: isPostHogConfigured() ? getPostHogClient(fetchFn) : null,
    })

  return (
    configuredApp
      .use(
        cors({
          origin: getCorsOriginsList(settings),
          credentials: settings.corsAllowCredentials,
          methods: settings.corsAllowMethods,
          allowedHeaders: settings.corsAllowHeaders,
          exposeHeaders: settings.corsExposeHeaders,
        }),
      )
      .use(createLoggerMiddleware(settings))
      .use(createHttpLoggingMiddleware(settings.trustedProxy))
      .use(createErrorHandlingMiddleware())
      // Auth routes (mounted at /api/auth/*)
      .use(betterAuthPlugin)
      // Mount route groups
      .use(createMainRoutes(auth, fetchFn))
      .use(createGoogleAuthRoutes(auth, fetchFn))
      .use(createMicrosoftAuthRoutes(auth, fetchFn))
      .use(createOidcConfigRoutes())
      .use(createProToolsRoutes(auth, fetchFn, createProRateLimit(database, rateLimitSettings)))
      .use(createUniversalProxyRoutes(auth, fetchFn, createProRateLimit(database, rateLimitSettings), proxyObserver))
      .use(createInferenceRoutes(auth, createInferenceRateLimit(database, rateLimitSettings)))
      .use(createConfigRoutes(settings))
      .use(createPostHogRoutes(fetchFn))
      .use(createMcpProxyRoutes(auth, fetchFn))
      .use(
        createWaitlistRoutes({
          database,
          auth,
          emailService: deps?.waitlistEmailService,
          cooldownMs: deps?.otpCooldownMs,
          ipRateLimit: createAuthIpRateLimit(database, ipRateLimitSettings),
        }),
      )
      .use(createPowerSyncRoutes(auth, settings, database))
      .use(createEncryptionRoutes(auth, database))
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

        if (settings.swaggerEnabled) {
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
    log.error({ err: error }, 'Failed to start server')
    process.exit(1)
  }
}

// Start the server if this file is run directly
if (import.meta.main) {
  startServer()
}

export { startServer }
