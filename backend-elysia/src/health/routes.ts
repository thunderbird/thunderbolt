import { getFlowerApiKey } from '@/auth/flower'
import { getSettings } from '@/config/settings'
import { buildUserIdHash } from '@/utils/request'
import { Elysia, t } from 'elysia'
import type { HealthCheckConfig, HealthCheckResponse, HealthCheckStatus } from './types'

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
  latency_ms: latencyMs,
  timestamp,
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
  latency_ms: latencyMs,
  timestamp,
  error,
  response: response || null,
})

/**
 * Collect content from a streaming-like response into a single string
 */
const collectStreamedContent = async (response: Response): Promise<string> => {
  if (!response.body) {
    return ''
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let collectedContent = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')

      for (let line of lines) {
        line = line.trim()
        if (!line) continue

        let dataStr = line
        if (line.startsWith('data: ')) {
          dataStr = line.substring(6)
        } else if (line.startsWith('data:')) {
          dataStr = line.substring(5)
        }

        dataStr = dataStr.trim()
        if (!dataStr || dataStr === '[DONE]') {
          if (dataStr === '[DONE]') break
          continue
        }

        try {
          const data = JSON.parse(dataStr)
          if (!data.choices || data.choices.length === 0) continue

          const choice = data.choices[0]
          const delta = choice.delta || {}
          let content = delta.content || ''

          if (!content && choice.text) {
            content = choice.text
          }

          if (!content && choice.message) {
            content = choice.message.content || ''
          }

          if (content) {
            collectedContent += content
          }
        } catch {
          // Ignore JSON parsing errors
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return collectedContent
}

/**
 * Validate monitoring token middleware
 */
const validateMonitoringToken = ({ query, set }: { query: Record<string, string | undefined>; set: any }) => {
  const settings = getSettings()
  const token = query.token

  if (!settings.monitoringToken) {
    set.status = 503
    return { error: 'Health check not configured' }
  }

  if (token !== settings.monitoringToken) {
    set.status = 401
    return { error: 'Invalid monitoring token' }
  }
}

/**
 * Create health check routes
 */
export const createHealthCheckRoutes = () => {
  return new Elysia({ prefix: '/healthcheck' })
    .get(
      '/flower/:model',
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

    .get(
      '/status',
      async ({ query, set }): Promise<HealthCheckStatus | { error: string }> => {
        // Validate monitoring token
        const tokenValidation = validateMonitoringToken({ query, set })
        if (tokenValidation) {
          return tokenValidation
        }

        const settings = getSettings()

        // Check service availability
        const services = {
          flower: {
            available: Boolean(settings.flowerMgmtKey && settings.flowerProjId),
            models: settings.flowerMgmtKey && settings.flowerProjId ? Object.keys(HEALTH_CHECK_CONFIGS) : [],
          },
        }

        return {
          timestamp: utcNow(),
          services,
          total_endpoints: Object.values(services).reduce((sum, service) => sum + service.models.length, 0),
        }
      },
      {
        query: t.Object({
          token: t.String(),
        }),
      },
    )
}
