/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createParser } from '@/lib/create-parser'
import { z } from 'zod'

/**
 * Schema for the document-result widget, used by the Haystack pipeline to
 * surface a single source document inline with a chat response.
 */
export const schema = z.object({
  widget: z.literal('document-result'),
  args: z.object({
    name: z.string().min(1, 'File name is required'),
    fileId: z.string().min(1, 'File ID is required'),
    snippet: z.string().optional(),
    score: z.string().optional(),
  }),
})

export type DocumentResultWidget = z.infer<typeof schema>

/** No persistent cache for this widget; sources are passed directly in args. */
export type CacheData = Record<string, never>

export const parse = createParser(schema)
