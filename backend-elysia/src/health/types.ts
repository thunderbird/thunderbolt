import { z } from 'zod'

/**
 * Health check response schema
 */
export const healthCheckResponseSchema = z.object({
  ok: z.boolean(),
  model: z.string(),
  service: z.string(),
  latency_ms: z.number(),
  timestamp: z.string(),
  response: z.string().nullable(),
  error: z.string().nullable(),
})

export type HealthCheckResponse = z.infer<typeof healthCheckResponseSchema>

/**
 * Health check status response schema
 */
export const healthCheckStatusSchema = z.object({
  timestamp: z.string(),
  services: z.record(
    z.object({
      available: z.boolean(),
      models: z.array(z.string()),
    }),
  ),
  total_endpoints: z.number(),
})

export type HealthCheckStatus = z.infer<typeof healthCheckStatusSchema>

/**
 * Health check configuration
 */
export interface HealthCheckConfig {
  prompt: string
  expected_response: string
  timeout: number
}
