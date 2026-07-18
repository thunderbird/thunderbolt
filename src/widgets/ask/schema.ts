/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createParser } from '@/lib/create-parser'
import { z } from 'zod'
import { askModes, type AskCacheEntry } from './lib'

const optionShape = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  isCorrect: z.boolean().optional(),
})

/**
 * The `options` attribute arrives as a JSON-encoded string (widget attributes
 * are always strings). Parse it leniently, then validate the decoded shape.
 */
const optionsAttr = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value)
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'options must be valid JSON' })
      return z.NEVER
    }
  })
  .pipe(z.array(optionShape).min(2))

export const schema = z.object({
  widget: z.literal('ask'),
  args: z.object({
    prompt: z.string().min(1),
    mode: z.enum(askModes),
    options: optionsAttr,
    explanation: z.string().optional(),
  }),
})

export type AskWidget = z.infer<typeof schema>

/** The user's persisted response to a single ask, stored in the message cache. */
export type CacheData = AskCacheEntry

export const parse = createParser(schema)
