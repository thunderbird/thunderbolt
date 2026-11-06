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
    // `free` is legacy-only: removed from authoring (see lib.ts) but still
    // accepted so historical messages keep rendering instead of failing
    // validation and degrading to raw text.
    mode: z.enum([...askModes, 'free']),
    // Optional because legacy `free` widgets carry no options; the current
    // modes still emit them and `optionsAttr` enforces min-2 when present. (A
    // cross-field "non-free ⇒ options required" rule can't live here without
    // wrapping args in `.refine()`, which would break `createParser`'s
    // reliance on `args.shape`.)
    options: optionsAttr.optional(),
    explanation: z.string().optional(),
  }),
})

export type AskWidget = z.infer<typeof schema>

/** The user's persisted response to a single ask, stored in the message cache. */
export type CacheData = AskCacheEntry

export const parse = createParser(schema)
