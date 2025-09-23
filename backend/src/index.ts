import { createGoogleAuthRoutes } from '@/auth/google'
import { createMicrosoftAuthRoutes } from '@/auth/microsoft'
import { getCorsOriginsList, getSettings } from '@/config/settings'
import { createHealthCheckRoutes } from '@/health/routes'
import { createProToolsRoutes } from '@/pro/routes'
import { createFlowerRoutes } from '@/routes/flower'
import { createMainRoutes } from '@/routes/main'
import { createOpenAIRoutes } from '@/routes/openai'
import { createPostHogRoutes } from '@/routes/posthog'
import { cors } from '@elysiajs/cors'
import { swagger } from '@elysiajs/swagger'
import { Elysia } from 'elysia'

/**
 * Create the main Elysia application
 */
const createApp = async () => {
  const settings = getSettings()

  const app = new Elysia({
    prefix: '/v1',
  })
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
        methods: settings.corsAllowMethods,
        allowedHeaders: settings.corsAllowHeaders,
        exposeHeaders: settings.corsExposeHeaders,
      }),
    )
    .onError(({ code, error, set }) => {
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
            console.error('Request error:', error)

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
    .use(createOpenAIRoutes())
    .use(createPostHogRoutes())
    .use(createFlowerRoutes())

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

    const hostname = process.env.HOST ? process.env.HOST : process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost'
    
    app.listen({
      hostname,
      port: settings.port,
      reusePort: true,
    }, () => {
      console.log(`🦊 Elysia is running at http://localhost:${settings.port}`)
      console.log(`📚 Documentation available at http://localhost:${settings.port}/swagger`)
    })

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('Shutting down gracefully...')
      process.exit(0)
    })

    process.on('SIGTERM', async () => {
      console.log('Shutting down gracefully...')
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
