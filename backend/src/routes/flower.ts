import { getFlowerApiKey } from '@/auth/flower'
import { getCorsOrigins, getSettings } from '@/config/settings'
import cors from '@elysiajs/cors'
import { Elysia, t } from 'elysia'
import { z } from 'zod'
import { buildUserIdHash, defaultRequestDenylist, extractResponseHeaders, filterHeaders } from '../utils/request'

/**
 * Health check response schema
 */
const healthCheckResponseSchema = z.object({
  ok: z.boolean(),
  model: z.string(),
  service: z.string(),
  latency_ms: z.number(),
  timestamp: z.string(),
  response: z.string().nullable(),
  error: z.string().nullable(),
})

type HealthCheckResponse = z.infer<typeof healthCheckResponseSchema>

/**
 * Health check configuration
 */
interface HealthCheckConfig {
  prompt: string
  expected_response: string
  timeout: number
}

const FLOWER_CHAT_COMPLETIONS_URL = 'https://api.flower.ai/v1/chat/completions'
const HEALTHCHECK_USER_AGENT = 'Thunderbolt-HealthCheck/1.0'

/**
 * Get current UTC time as RFC3339 with a trailing Z
 */
const utcNow = (): string => {
  return new Date().toISOString()
}

/**
 * Health check configurations for different models
 */
const HEALTH_CHECK_CONFIGS: Record<string, HealthCheckConfig> = {
  'qwen/qwen3-235b': {
    prompt: 'Hello, this is a healthcheck, please respond with the exact string "Healthcheck confirmed."',
    expected_response: 'Healthcheck confirmed.',
    timeout: 15000,
  },
  // Add more models here as needed
}

/**
 * Default health check configuration for any model not specifically configured
 */
const DEFAULT_HEALTH_CHECK_CONFIG: HealthCheckConfig = {
  prompt: 'Hello, this is a healthcheck, please respond with the exact string "Healthcheck confirmed."',
  expected_response: 'Healthcheck confirmed.',
  timeout: 15000,
}

/**
 * Create success response
 */
const createSuccessResponse = (
  model: string,
  service: string,
  timestamp: string,
  latencyMs: number,
  response: string,
): HealthCheckResponse => ({
  ok: true,
  model,
  service,
  timestamp,
  latency_ms: latencyMs,
  response,
  error: null,
})

/**
 * Create error response
 */
const createErrorResponse = (
  model: string,
  service: string,
  timestamp: string,
  latencyMs: number,
  error: string,
  response?: string,
): HealthCheckResponse => ({
  ok: false,
  model,
  service,
  timestamp,
  latency_ms: latencyMs,
  error,
  response: response || null,
})

/**
 * Collect streamed content from response
 */
const collectStreamedContent = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('No response body reader available')
  }

  let collectedContent = ''
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')

      for (const line of lines) {
        if (line.trim() === '') continue

        if (line.startsWith('data: ')) {
          const data = line.slice(6)

          if (data === '[DONE]') {
            return collectedContent
          }

          try {
            const parsed = JSON.parse(data)
            const content = parsed?.choices?.[0]?.delta?.content
            if (typeof content === 'string') {
              collectedContent += content
            }
          } catch {
            // Ignore JSON parsing errors for individual chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return collectedContent
}

/**
 * Validate monitoring token
 */
const validateMonitoringToken = ({ query, set }: any) => {
  const settings = getSettings()
  
  if (!settings.monitoringToken) {
    set.status = 503
    return { error: 'Monitoring token not configured' }
  }

  if (query.token !== settings.monitoringToken) {
    set.status = 401
    return { error: 'Invalid monitoring token' }
  }
}

/**
 * Flower AI proxy routes
 */
export const createFlowerRoutes = () => {
  const settings = getSettings()
  
  return new Elysia({
    prefix: '/flower',
  }).use(
    cors({
      origin: getCorsOrigins(settings),
      allowedHeaders: [...settings.corsAllowHeaders.split(','), 'fi-sdk-type', 'fi-sdk-version'],
      exposeHeaders: settings.corsExposeHeaders,
    }),
  )
  .post('/api-key', async ({ headers }): Promise<{ api_key: string }> => {
    const settings = getSettings()

    if (!settings.flowerMgmtKey || !settings.flowerProjId) {
      throw new Error('Flower AI not configured')
    }

    // Derive a stable, non-PII user identifier for per-user API keys
    const ctx = { headers } as any // Simplified context for buildUserIdHash
    const userIdHash = buildUserIdHash(ctx, 'unknown')

    try {
      const apiKey = await getFlowerApiKey(userIdHash, undefined, settings)
      return { api_key: apiKey }
    } catch (error) {
      throw new Error(`Failed to get Flower API key: ${String(error)}`)
    }
  })
  .get(
    '/healthcheck/:model',
    async ({ params, query, set, headers }): Promise<HealthCheckResponse> => {
      // Validate monitoring token
      const tokenValidation = validateMonitoringToken({ query, set })
      if (tokenValidation) {
        return tokenValidation as HealthCheckResponse
      }

      const model = params.model
      const startTime = Date.now()
      const timestamp = utcNow()
      const settings = getSettings()

      // Get model configuration (use default if not specifically configured)
      const modelConfig = HEALTH_CHECK_CONFIGS[model] || DEFAULT_HEALTH_CHECK_CONFIG

      // Early return if Flower AI not configured
      if (!settings.flowerMgmtKey || !settings.flowerProjId) {
        const latencyMs = Math.round(Date.now() - startTime)
        return createErrorResponse(model, 'flower', timestamp, latencyMs, 'Flower AI not configured')
      }

      try {
        // Get Flower API key using existing auth system
        const ctx = { headers } as any // Simplified context for buildUserIdHash
        const userIdHash = buildUserIdHash(ctx)

        const apiKey = await getFlowerApiKey(userIdHash, undefined, settings)

        // Build the request payload
        const payload = {
          model,
          messages: [
            {
              role: 'user',
              content: modelConfig.prompt,
            },
          ],
          stream: true,
          max_tokens: 50,
          temperature: 0.0, // Deterministic responses for reliable testing
        }

        // Make streaming request to Flower AI
        const requestHeaders = {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': HEALTHCHECK_USER_AGENT,
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), modelConfig.timeout)

        try {
          const response = await fetch(FLOWER_CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify(payload),
            signal: controller.signal,
          })

          clearTimeout(timeoutId)

          if (!response.ok) {
            const latencyMs = Math.round(Date.now() - startTime)

            // Handle model not allowed errors specifically
            let errorMessage = `HTTP ${response.status}: ${response.statusText}`
            try {
              const errorData = await response.json()
              if (errorData.detail) {
                const detail = errorData.detail
                if (typeof detail === 'object' && detail.code === '40001') {
                  errorMessage = `Model '${model}' is not available in your Flower AI project. Please check your project configuration or use a different model name.`
                } else if (typeof detail === 'string') {
                  errorMessage = detail
                }
              }
            } catch {
              // Ignore JSON parsing errors
            }

            return createErrorResponse(model, 'flower', timestamp, latencyMs, errorMessage)
          }

          const collectedContent = await collectStreamedContent(response)

          // Calculate final latency
          const latencyMs = Math.round(Date.now() - startTime)

          // Validate response matches exactly what we expect
          const expected = modelConfig.expected_response
          const actual = collectedContent.trim()

          if (actual === expected) {
            return createSuccessResponse(model, 'flower', timestamp, latencyMs, actual)
          }

          return createErrorResponse(
            model,
            'flower',
            timestamp,
            latencyMs,
            `Response mismatch: expected '${expected}' but got '${actual}'`,
            actual,
          )
        } catch (error) {
          clearTimeout(timeoutId)

          if (error instanceof Error && error.name === 'AbortError') {
            const latencyMs = Math.round(Date.now() - startTime)
            return createErrorResponse(
              model,
              'flower',
              timestamp,
              latencyMs,
              `Request timeout after ${modelConfig.timeout / 1000}s`,
            )
          }
          throw error
        }
      } catch (error) {
        const latencyMs = Math.round(Date.now() - startTime)
        console.error(`Health check failed for ${model}:`, error)
        return createErrorResponse(model, 'flower', timestamp, latencyMs, String(error))
      }
    },
    {
      params: t.Object({
        model: t.String(),
      }),
      query: t.Object({
        token: t.String(),
      }),
    },
  )
  .all(
    '/*',
    async (ctx) => {
      const path = ctx.params['*'] || ''
      const url = `https://api.flower.ai/${path}`

      const headers = filterHeaders(ctx.headers, defaultRequestDenylist)

      const response = await fetch(url + (ctx.query ? `?${new URLSearchParams(ctx.query)}` : ''), {
        method: ctx.request.method,
        headers,
        body: ctx.request.body as BodyInit,
      })

      return new Response(response.body, {
        status: response.status,
        headers: extractResponseHeaders(response.headers),
      })
    },
    {
      parse: 'none',
    },
  )
}
