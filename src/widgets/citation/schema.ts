import { createParser } from '@/lib/create-parser'
import { z } from 'zod'

/**
 * Zod schema for citation widget
 */
export const schema = z.object({
  widget: z.literal('citation'),
  args: z.object({
    sources: z.string().min(1, 'Sources are required'),
  }),
})

export type CitationWidget = z.infer<typeof schema>

/**
 * Parse function - auto-generated from schema
 */
export const parse = createParser(schema)
