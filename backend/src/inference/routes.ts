import { validateCorsOrigin } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { createSSEStreamFromCompletion } from '@/utils/streaming'
import type { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { Elysia } from 'elysia'
import { APIConnectionError, APIConnectionTimeoutError } from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { getInferenceClient, type InferenceProvider } from './client'

/**
 * Parse Tinfoil usage metrics from header format: "prompt=67,completion=42,total=109"
 * Handles malformed input gracefully by skipping invalid entries
 */
const parseUsageMetrics = (metricsString: string): { prompt: number; completion: number; total: number } => {
  const pairs = metricsString.split(',')
  const metrics: Record<string, number> = {}

  for (const pair of pairs) {
    const [key, value] = pair.split('=')
    if (!key || !value) continue
    const num = Number.parseInt(value.trim(), 10)
    if (!Number.isNaN(num) && num >= 0) {
      metrics[key.trim()] = num
    }
  }

  return {
    prompt: metrics.prompt ?? 0,
    completion: metrics.completion ?? 0,
    total: metrics.total ?? 0,
  }
}

/**
 * Track usage metrics in PostHog (similar to standard providers)
 * Usage metrics come from HTTP trailers, not encrypted body, so we can track them
 */
const trackTinfoilUsage = (
  metrics: { prompt: number; completion: number; total: number },
  duration: number,
  model: string,
): void => {
  if (isPostHogConfigured()) {
    try {
      const posthog = getPostHogClient()
      posthog.capture({
        distinctId: 'tinfoil-user', // TODO: Get actual user ID from context if available
        event: 'inference_usage',
        properties: {
          model,
          model_provider: 'tinfoil',
          prompt_tokens: metrics.prompt,
          completion_tokens: metrics.completion,
          total_tokens: metrics.total,
          duration_ms: duration,
          endpoint: '/chat/completions',
        },
      })
    } catch (error) {
      // Don't fail request if PostHog tracking fails (consistent with standard providers)
      console.error('[EHBP] Failed to track usage in PostHog:', error)
    }
  }
}

type Message = { role: string; content: unknown }

const privilegedRoles = new Set(['developer', 'system'])

/** Downgrade developer/system roles to user for all messages except the first (the legitimate system prompt). */
const sanitizeMessageRoles = (messages: Message[]): Message[] =>
  messages.map((msg, i) => (i > 0 && privilegedRoles.has(msg.role) ? { ...msg, role: 'user' } : msg))

type ModelConfig = {
  provider: InferenceProvider
  internalName: string
}

export const supportedModels: Record<string, ModelConfig> = {
  'gpt-oss-120b': {
    provider: 'tinfoil', // Tinfoil POC: OpenAI-compatible client with encrypted inference
    internalName: 'gpt-oss-120b',
  },
  'mistral-medium-3.1': {
    provider: 'mistral',
    internalName: 'mistral-medium-2508',
  },
  'mistral-large-3': {
    provider: 'mistral',
    internalName: 'mistral-large-2512',
  },
  'sonnet-4.5': {
    provider: 'anthropic',
    internalName: 'claude-sonnet-4-5',
  },
}

/**
 * Inference API routes
 */
export const createInferenceRoutes = () => {
  return new Elysia({
    prefix: '/chat',
  })
    .onError(safeErrorHandler)
    .post('/completions', async (ctx) => {
      // EHBP passthrough: Forward encrypted requests directly to Tinfoil enclave
      // Both headers are required for EHBP requests
      const ehbpKey = ctx.request.headers.get('ehbp-encapsulated-key')
      const enclaveBaseUrl = ctx.request.headers.get('x-tinfoil-enclave-url')
      const isEhbpEncrypted = !!(ehbpKey && enclaveBaseUrl)

      if (isEhbpEncrypted) {
        const { getSettings } = await import('@/config/settings')
        const settings = getSettings()

        if (!settings.tinfoilApiKey?.trim()) {
          throw new Error('Tinfoil API key not configured')
        }

        if (!enclaveBaseUrl) {
          throw new Error('X-Tinfoil-Enclave-Url header missing')
        }

        // Validate URL to prevent SSRF attacks
        let parsedUrl: URL
        try {
          parsedUrl = new URL(enclaveBaseUrl)
        } catch (_error) {
          throw new Error(`Invalid enclave URL: ${enclaveBaseUrl}`)
        }

        // Security: Only allow HTTPS protocol
        if (parsedUrl.protocol !== 'https:') {
          throw new Error('Enclave URL must use HTTPS protocol')
        }

        // Security: Validate hostname against allowlist to prevent API key leakage
        const allowedHostnames = settings.tinfoilEnclaveAllowedHostnames
          .split(',')
          .map((h) => h.trim())
          .filter((h) => h.length > 0)

        if (allowedHostnames.length === 0) {
          throw new Error('No allowed Tinfoil enclave hostnames configured')
        }

        const hostname = parsedUrl.hostname.toLowerCase()
        const isHostnameAllowed = allowedHostnames.some((allowed) => allowed.toLowerCase() === hostname)

        if (!isHostnameAllowed) {
          // Log detailed error server-side but return generic error to client
          console.error(`[EHBP] Rejected disallowed hostname: ${hostname}. Allowed: ${allowedHostnames.join(', ')}`)
          throw new Error('Request to disallowed enclave hostname')
        }

        const upstreamUrl = `${enclaveBaseUrl}/v1/chat/completions`
        const upstreamParsedUrl = new URL(upstreamUrl)
        const requestStartTime = Date.now()

        // Use Node's https module (Bun-compatible) to access HTTP trailers
        const https = await import('node:https')

        // Read request body from stream with error handling
        if (!ctx.request.body) {
          throw new Error('Request body is required for EHBP requests')
        }

        // Security: Limit request body size to prevent DoS attacks
        // 10MB limit (reasonable for LLM requests with long context)
        const MAX_BODY_SIZE = 10 * 1024 * 1024
        let requestBody: Uint8Array
        try {
          const requestBodyChunks: Uint8Array[] = []
          const bodyReader = ctx.request.body.getReader()
          let totalSize = 0

          while (true) {
            const { done, value } = await bodyReader.read()
            if (done) break
            if (value) {
              totalSize += value.length
              if (totalSize > MAX_BODY_SIZE) {
                throw new Error(`Request body exceeds maximum size of ${MAX_BODY_SIZE} bytes`)
              }
              requestBodyChunks.push(value)
            }
          }

          const requestBodyLength = requestBodyChunks.reduce((acc, chunk) => acc + chunk.length, 0)
          requestBody = new Uint8Array(requestBodyLength)
          let offset = 0
          for (const chunk of requestBodyChunks) {
            requestBody.set(chunk, offset)
            offset += chunk.length
          }
        } catch (error) {
          throw new Error(`Failed to read request body: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }

        // Request timeout: 5 minutes (300000ms)
        const REQUEST_TIMEOUT_MS = 300000

        return new Promise<Response>((resolve, reject) => {
          let isResolved = false
          let req: ReturnType<typeof https.request> | null = null
          let timeoutId: ReturnType<typeof setTimeout> | null = null

          const resolveOnce = (response: Response) => {
            if (!isResolved) {
              isResolved = true
              resolve(response)
            }
          }
          const rejectOnce = (error: Error) => {
            if (!isResolved) {
              isResolved = true
              reject(error)
            }
          }

          // Handle client disconnect (AbortSignal)
          const abortHandler = () => {
            if (req) {
              req.destroy()
            }
            if (timeoutId !== null) {
              clearTimeout(timeoutId)
            }
            rejectOnce(new Error('Request aborted by client'))
          }
          if (ctx.request.signal) {
            if (ctx.request.signal.aborted) {
              rejectOnce(new Error('Request already aborted'))
              return
            }
            ctx.request.signal.addEventListener('abort', abortHandler)
          }

          const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : 443
          if (Number.isNaN(port) || port <= 0 || port > 65535) {
            throw new Error(`Invalid port in enclave URL: ${parsedUrl.port}`)
          }

          const options = {
            hostname: parsedUrl.hostname,
            port,
            path: upstreamParsedUrl.pathname + upstreamParsedUrl.search,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${settings.tinfoilApiKey}`,
              'Content-Type': 'application/json',
              Accept: ctx.request.headers.get('accept') || 'application/json',
              'X-Tinfoil-Request-Usage-Metrics': 'true',
              'Content-Length': requestBody.length,
              ...(ehbpKey && { 'Ehbp-Encapsulated-Key': ehbpKey }),
            },
          }

          // Set up timeout (after req is created)
          timeoutId = setTimeout(() => {
            if (req) {
              req.destroy()
            }
            rejectOnce(new Error('Request timeout after 5 minutes'))
          }, REQUEST_TIMEOUT_MS)

          req = https.request(options, (res) => {
            // Replace connection timeout with stream activity timeout
            // Ensures stalled streams are eventually cleaned up
            if (timeoutId !== null) {
              clearTimeout(timeoutId)
            }
            const resetStreamTimeout = () => {
              if (timeoutId !== null) {
                clearTimeout(timeoutId)
              }
              timeoutId = setTimeout(() => {
                if (req) {
                  req.destroy()
                }
                rejectOnce(new Error('Stream timeout - no data received for 5 minutes'))
              }, REQUEST_TIMEOUT_MS)
            }
            resetStreamTimeout() // Start stream timeout

            // Handle error status codes (consistent with standard provider error handling)
            // Buffer error responses to prevent leaking internal error details
            if (res.statusCode && res.statusCode >= 400) {
              const errorChunks: Buffer[] = []

              res.on('data', (chunk: Buffer) => {
                errorChunks.push(chunk)
              })

              res.on('end', () => {
                const errorBody = Buffer.concat(errorChunks).toString()
                console.error(`[EHBP] Upstream error ${res.statusCode ?? 'unknown'}:`, errorBody)

                // Return sanitized error to prevent leaking internal details
                rejectOnce(new Error('Inference request failed'))
              })

              res.on('error', (error: Error) => {
                console.error('[EHBP] Error reading error response:', error)
                rejectOnce(new Error('Inference request failed'))
              })

              // Request will be cleaned up by error handlers or cleanup function
              return
            }

            const ehbpResponseNonce = res.headers['ehbp-response-nonce']

            if (!ehbpResponseNonce) {
              console.warn('[EHBP] Missing Ehbp-Response-Nonce in response')
            }

            // Create stream to pipe response to client
            const { readable, writable } = new TransformStream()
            const writer = writable.getWriter()
            let writerError: Error | null = null

            // Pipe response chunks
            res.on('data', async (chunk: Buffer) => {
              resetStreamTimeout() // Reset timeout on each data chunk
              if (writerError) return // Don't write after error
              try {
                await writer.write(new Uint8Array(chunk))
              } catch (error) {
                if (!writerError) {
                  writerError = error as Error
                  console.error('[EHBP] Error writing chunk:', error)
                  // Abort upstream request if writer fails
                  if (req) {
                    req.destroy()
                  }
                }
              }
            })

            // Capture trailers when response ends
            res.on('end', async () => {
              // Clear stream timeout on successful completion
              if (timeoutId !== null) {
                clearTimeout(timeoutId)
              }
              try {
                const usageMetrics = res.trailers?.['x-tinfoil-usage-metrics']

                if (usageMetrics) {
                  const metrics = parseUsageMetrics(usageMetrics)
                  const duration = Date.now() - requestStartTime

                  // Log usage (consistent with standard providers)
                  console.info('[Usage]', {
                    model: 'gpt-oss-120b',
                    provider: 'tinfoil',
                    promptTokens: metrics.prompt,
                    completionTokens: metrics.completion,
                    totalTokens: metrics.total,
                    durationMs: duration,
                  })

                  // Track usage metrics in PostHog (similar to standard providers)
                  // Usage metrics come from trailers, not encrypted body, so we can track them
                  trackTinfoilUsage(metrics, duration, 'gpt-oss-120b')
                }

                if (!writerError) {
                  await writer.close()
                } else {
                  writer.abort(writerError)
                }
              } catch (error) {
                console.error('[EHBP] Error in end handler:', error)
                if (!writerError) {
                  writerError = error as Error
                  writer.abort(writerError)
                }
              }
            })

            res.on('error', (error: Error) => {
              console.error('[EHBP] Response stream error:', error)
              if (!writerError) {
                writerError = error
                writer.abort(error)
              }
              if (req) {
                req.destroy()
              }
            })

            // Validate origin using same logic as CORS middleware
            // Never use wildcard '*' with credentials (violates CORS spec)
            const originHeader = ctx.request.headers.get('origin')
            const validatedOrigin = validateCorsOrigin(originHeader, settings)

            const responseHeaders = new Headers({
              'Content-Type': res.headers['content-type'] || 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'Access-Control-Expose-Headers': 'Ehbp-Response-Nonce',
            })

            // Only set CORS headers if origin is valid
            // This ensures EHBP responses use the same origin validation as the rest of the API
            if (validatedOrigin) {
              responseHeaders.set('Access-Control-Allow-Origin', validatedOrigin)
              if (settings.corsAllowCredentials) {
                responseHeaders.set('Access-Control-Allow-Credentials', 'true')
              }
            }

            if (ehbpResponseNonce && typeof ehbpResponseNonce === 'string') {
              responseHeaders.set('Ehbp-Response-Nonce', ehbpResponseNonce)
            }

            // Resolve with streaming response
            // Errors during streaming are handled by writer.abort() in stream event handlers
            resolveOnce(
              new Response(readable, {
                status: res.statusCode || 200,
                headers: responseHeaders,
              }),
            )
          })

          req.on('error', (error: Error) => {
            if (timeoutId !== null) {
              clearTimeout(timeoutId)
            }
            console.error('[EHBP] Request error:', error)
            // Map to similar error pattern as standard providers
            // This provides consistency even though we can't use APIConnectionError
            const errorMessage = error.message.includes('timeout')
              ? 'Connection timeout to inference provider'
              : error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')
                ? 'Failed to connect to inference provider'
                : `Failed to proxy request to Tinfoil: ${error.message}`
            rejectOnce(new Error(errorMessage))
          })

          // Clean up abort listener on completion
          const cleanup = () => {
            if (ctx.request.signal) {
              ctx.request.signal.removeEventListener('abort', abortHandler)
            }
            if (timeoutId !== null) {
              clearTimeout(timeoutId)
            }
          }

          req.on('close', cleanup)
          req.on('error', cleanup)

          req.write(requestBody)
          req.end()
        })
      }

      // Standard flow: Parse JSON body for non-encrypted requests
      const body = await ctx.request.json()

      if (!body.stream) {
        throw new Error('Non-streaming requests are not supported')
      }

      const modelConfig = supportedModels[body.model]
      if (!modelConfig) {
        throw new Error('Model not found')
      }

      const { provider, internalName } = modelConfig

      // Tinfoil requests should always use EHBP (handled above)
      if (provider === 'tinfoil') {
        throw new Error('Tinfoil requests must use EHBP encryption')
      }

      // Standard flow for other providers
      const { client } = getInferenceClient(provider)

      console.info(`Routing model "${body.model}" to ${provider} provider`)

      try {
        const completion = await (client as PostHogOpenAI).chat.completions.create({
          model: internalName,
          messages: sanitizeMessageRoles(body.messages) as ChatCompletionMessageParam[],
          temperature: body.temperature,
          tools: body.tools,
          tool_choice: body.tool_choice,
          stream: true,
          ...(isPostHogConfigured() && {
            posthogProperties: {
              model_provider: provider,
              endpoint: '/chat/completions',
              has_tools: !!body.tools,
              temperature: body.temperature,
              // @todo add distinct id and trace id
            },
          }),
        })

        const stream = createSSEStreamFromCompletion(completion, body.model)

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      } catch (error) {
        if (error instanceof APIConnectionError) {
          console.error('Failed to connect to inference provider', error.cause)
          throw new Error('Failed to connect to inference provider')
        }
        if (error instanceof APIConnectionTimeoutError) {
          console.error('Connection timeout to inference provider', error.cause)
          throw new Error('Connection timeout to inference provider')
        }
        throw error
      }
    })
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use createInferenceRoutes instead
 */
export const createOpenAIRoutes = createInferenceRoutes
