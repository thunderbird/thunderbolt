/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
    override: z.enum(['true', '']),
  }),
})

export type ConnectIntegrationWidget = z.infer<typeof schema>

/**
 * Type of data cached by this widget
 * isHidden: Whether the widget should be hidden after integration completion
 */
export type CacheData = {
  isHidden?: boolean
}

/**
 * Parse function - auto-generated from schema
 */
export const parse = createParser(schema)
