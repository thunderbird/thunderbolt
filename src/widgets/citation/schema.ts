/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createParser } from '@/lib/create-parser'
import { decodeCitationSources } from '@/lib/citation-utils'
import { z } from 'zod'

/**
 * Validates that a sources string is valid JSON (raw or base64) with valid sources.
 * Keeps the string format for widget args — parsing happens in the component.
 */
const validateSourcesString = (sources: string): boolean => {
  const decoded = decodeCitationSources(sources)
  return decoded !== null && decoded.length > 0
}

/**
 * Zod schema for citation widget
 */
export const schema = z.object({
  widget: z.literal('citation'),
  args: z.object({
    sources: z
      .string()
      .min(1, 'Sources are required')
      .refine(
        validateSourcesString,
        'Invalid citation sources: must be valid JSON with required id, title, and url fields',
      ),
  }),
})

export type CitationWidget = z.infer<typeof schema>

/**
 * Parse function - auto-generated from schema
 */
export const parse = createParser(schema)
