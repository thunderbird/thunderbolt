import { createGoogleAuthRoutes } from '@/auth/google'
import { createMicrosoftAuthRoutes } from '@/auth/microsoft'
import { getCorsMethodsList, getCorsOriginsList, getSettings } from '@/config/settings'
import { createHealthCheckRoutes } from '@/health/routes'
import { createProToolsRoutes } from '@/pro/routes'
import { proxyService } from '@/proxy/service'
import { createModelTransformer } from '@/proxy/transformers'
import { createProxyConfig } from '@/proxy/types'
import { createMainRoutes } from '@/routes/main'
import { createProxyRoutes } from '@/routes/proxy'
import { cors } from '@elysiajs/cors'
import { swagger } from '@elysiajs/swagger'
import { Elysia } from 'elysia'

/**
 * Initialize proxy configurations
 */
const initializeProxies = async () => {
  const settings = getSettings()

  // Fireworks OpenAI-compatible proxy
  if (settings.fireworksApiKey) {
    proxyService.registerProxy(
      '/openai',
      createProxyConfig({
        targetUrl: 'https://api.fireworks.ai/inference/v1',
        apiKey: settings.fireworksApiKey,
        apiKeyHeader: 'Authorization',
        apiKeyAsQueryParam: false,
        requireAuth: false, // Frontend doesn't need to authenticate
        supportsStreaming: true, // Enable streaming support
        requestTransformer: createModelTransformer('accounts/fireworks/models/', 'accounts/'), // Transform model names
      }),
    )
  }

  // Flower AI proxy
  if (settings.flowerMgmtKey && settings.flowerProjId) {
    proxyService.registerProxy(
      '/flower',
      createProxyConfig({
        targetUrl: 'https://api.flower.ai',
        apiKey: '', // Will be set dynamically per request
        apiKeyHeader: 'Authorization',
        apiKeyAsQueryParam: false,
        requireAuth: false, // Allow preflight requests
        supportsStreaming: true, // Enable streaming support
      }),
    )
  }

  // PostHog Analytics proxy
  proxyService.registerProxy(
    '/posthog',
    createProxyConfig({
      targetUrl: settings.posthogHost,
      apiKey: '', // No API key needed for PostHog client-side tracking
      apiKeyHeader: 'Authorization',
      apiKeyAsQueryParam: false,
      requireAuth: false, // Allow public access for analytics
      supportsStreaming: false, // PostHog doesn't use streaming
    }),
  )

  console.info('Proxy configurations initialized')
}

/**
 * Create the main Elysia application
 */
const createApp = async () => {
  const settings = getSettings()

  // Initialize proxies
  await initializeProxies()

  const app = new Elysia()
    .use(
      swagger({
        documentation: {
          info: {
            title: 'Thunderbolt Backend (Elysia)',
            description: 'A TypeScript backend with proxy capabilities built with Elysia',
            version: '0.1.0',
          },
        },
      }),
    )
    .use(
      cors({
        origin: settings.corsOriginRegex ? new RegExp(settings.corsOriginRegex) : getCorsOriginsList(settings),
        credentials: settings.corsAllowCredentials,
        methods: getCorsMethodsList(settings),
        allowedHeaders: settings.corsAllowHeaders === '*' ? ['*'] : [settings.corsAllowHeaders],
        exposeHeaders: settings.corsExposeHeaders ? [settings.corsExposeHeaders] : [],
      }),
    )
    .onError(({ code, error, set }) => {
      console.error('Request error:', error)

      switch (code) {
        case 'VALIDATION':
          set.status = 400
          return {
            error: 'Validation failed',
            message: error.message,
          }
        case 'NOT_FOUND':
          set.status = 404
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
              return {
                error: 'Service unavailable',
                message: error.message,
              }
            }

            if (status === 401) {
              return {
                error: 'Unauthorized',
                message: error.message,
              }
            }

            if (status === 400) {
              return {
                error: 'Bad request',
                message: error.message,
              }
            }
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
    .use(createHealthCheckRoutes())
    .use(createProxyRoutes())

  return app
}

/**
 * Start the server
 */
const startServer = async () => {
  const settings = getSettings()

  // Set up logging
  console.log('Starting Thunderbolt Backend (Elysia)...')
  console.log(`Log level: ${settings.logLevel}`)
  console.log(`Port: ${settings.port}`)
  console.log(`CORS origins: ${getCorsOriginsList(settings).join(', ')}`)

  try {
    const app = await createApp()

    app.listen(settings.port, () => {
      console.log(`🦊 Elysia is running at http://localhost:${settings.port}`)
      console.log(`📚 Documentation available at http://localhost:${settings.port}/swagger`)
    })

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('Shutting down gracefully...')
      await proxyService.close()
      process.exit(0)
    })

    process.on('SIGTERM', async () => {
      console.log('Shutting down gracefully...')
      await proxyService.close()
      process.exit(0)
    })
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

// Start the server if this file is run directly
if (import.meta.main) {
  startServer()
}

export { createApp, startServer }
