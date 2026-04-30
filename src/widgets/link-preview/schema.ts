/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type LinkPreviewData } from '@/integrations/thunderbolt-pro/schemas'
import { createParser } from '@/lib/create-parser'
import { z } from 'zod'

/**
 * Zod schema for link-preview widget
 */
export const schema = z.object({
  widget: z.literal('link-preview'),
  args: z.object({
    url: z.string().url('Invalid URL').min(1, 'URL is required'),
    source: z.string().optional(),
  }),
})

export type LinkPreviewWidget = z.infer<typeof schema>

/**
 * Type of data cached by this widget
 */
export type CacheData = LinkPreviewData

/**
 * Parse function - auto-generated from schema
 */
export const parse = createParser(schema)
