import { createParser } from '@/lib/create-parser'
import { z } from 'zod'

/**
 * Zod schema for connect-integration widget
 */
export const schema = z.object({
  widget: z.literal('connect-integration'),
  args: z.object({
    provider: z.enum(['google', 'microsoft', '']),
    service: z.enum(['email', 'calendar', 'both']),
    reason: z.string(),
  }),
})

export type ConnectIntegrationWidget = z.infer<typeof schema>

/**
 * Type of data cached by this widget (none - this widget doesn't fetch data)
 */
export type CacheData = null

/**
 * Parse function - auto-generated from schema
 */
export const parse = createParser(schema)
