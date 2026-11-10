/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getToolName, isToolOrDynamicToolUIPart, type UIMessage } from 'ai'
import { z } from 'zod'
import type { PageDefinition } from '@shared/page-protocol'

const maxHtmlBytes = 2 * 1024 * 1024
// JSON can escape every source character as six bytes. Bound parsing before allocating it.
const maxResultCharacters = 16 * 1024 * 1024
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/)
const reference = z.string().min(1).max(500)
const url = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => {
    if (value === 'about:blank') {
      return true
    }
    if (Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      return false
    }
    try {
      const parsed = new URL(value)
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
    } catch {
      return false
    }
  })
const pageSchema = z.object({
  id: identifier,
  title: z.string().max(200),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('url'), url }),
    z.object({
      kind: z.literal('html'),
      html: z
        .string()
        .min(1)
        .max(maxHtmlBytes)
        .refine((value) => new TextEncoder().encode(value).byteLength <= maxHtmlBytes),
      artifact: z
        .object({
          toolCallId: reference,
          messageId: reference.optional(),
          chatThreadId: reference.nullable().optional(),
        })
        .optional(),
    }),
    z.object({ kind: z.literal('local-app'), appId: reference, projectId: reference.optional() }),
  ]),
}) satisfies z.ZodType<PageDefinition>

export type PublishedPageOutput = { page: PageDefinition; sessionId?: string }
const outputSchema = z.object({
  ok: z.boolean().optional(),
  page: pageSchema,
  sessionId: reference.optional(),
  status: z.string().optional(),
})
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A result is data, not a command: only successful known publishing tools may create transcript pages. */
export const publishedPageOutput = (part: UIMessage['parts'][number]): PublishedPageOutput | null => {
  if (!isToolOrDynamicToolUIPart(part) || part.state !== 'output-available') {
    return null
  }
  const name = getToolName(part)
  if (!['page_open', 'page_show_file', 'local_app'].includes(name)) {
    return null
  }
  if (
    name === 'local_app' &&
    (!record(part.input) || !['create', 'start', 'restart'].includes(String(part.input.action)))
  ) {
    return null
  }

  const parse = (value: unknown): PublishedPageOutput | null => {
    const result = outputSchema.safeParse(value)
    if (!result.success || result.data.ok === false) {
      return null
    }
    const { page, sessionId } = result.data
    if (name === 'local_app') {
      if (page.source.kind !== 'local-app' || result.data.status !== 'ready') {
        return null
      }
    } else if (result.data.ok !== true || page.source.kind !== (name === 'page_show_file' ? 'html' : 'url')) {
      return null
    }
    return { page, ...(sessionId ? { sessionId } : {}) }
  }
  const direct = parse(part.output)
  if (direct) {
    return direct
  }
  if (!record(part.output)) {
    return null
  }
  // An explicit failure must never be rescued by a contradictory nested success.
  if (part.output.ok === false || part.output.isError === true) {
    return null
  }
  if (record(part.output.details) && (part.output.details.ok === false || part.output.details.isError === true)) {
    return null
  }
  const details = parse(part.output.details)
  if (details) {
    return details
  }
  const content = part.output.content
  if (!Array.isArray(content) || content.length > 32) {
    return null
  }
  for (const entry of content) {
    if (
      !record(entry) ||
      entry.type !== 'text' ||
      typeof entry.text !== 'string' ||
      entry.text.length > maxResultCharacters
    ) {
      continue
    }
    try {
      const result = parse(JSON.parse(entry.text) as unknown)
      if (result) {
        return result
      }
    } catch {
      /* Non-JSON provider text remains an ordinary tool result. */
    }
  }
  return null
}
