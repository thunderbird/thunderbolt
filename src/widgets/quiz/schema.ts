/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createParser } from '@/lib/create-parser'
import { z } from 'zod'
import type { QuizCacheEntry } from './lib'

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
  widget: z.literal('quiz'),
  args: z.object({
    prompt: z.string().min(1),
    mode: z.enum(['single', 'multiple', 'choice']),
    options: optionsAttr,
    explanation: z.string().optional(),
  }),
})

export type QuizWidget = z.infer<typeof schema>

/** The user's persisted answer to a single quiz, stored in the message cache. */
export type CacheData = QuizCacheEntry

export const parse = createParser(schema)
