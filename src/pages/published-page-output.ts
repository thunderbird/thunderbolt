/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getToolName, isToolOrDynamicToolUIPart, type UIMessage } from 'ai'
import { z } from 'zod'
import type { PageDefinition } from '@shared/page-protocol'

import { pageDefinitionSchema, pageReferenceSchema } from './page-schema'

// JSON can escape every source character as six bytes. Bound parsing before allocating it.
const maxResultCharacters = 16 * 1024 * 1024

export type PublishedPageOutput = {
  page: PageDefinition
  sessionId?: string
  updated?: boolean
  presentation?: 'sidebar' | 'inline'
}
const outputSchema = z.object({
  ok: z.boolean().optional(),
  page: pageDefinitionSchema,
  sessionId: pageReferenceSchema.optional(),
  status: z.string().optional(),
  updated: z.boolean().optional(),
  presentation: z.enum(['sidebar', 'inline']).optional(),
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
    (!record(part.input) || !['create', 'attach', 'start', 'restart', 'update'].includes(String(part.input.action)))
  ) {
    return null
  }

  const parse = (value: unknown): PublishedPageOutput | null => {
    const result = outputSchema.safeParse(value)
    if (!result.success || result.data.ok === false || (record(value) && value.isError === true)) {
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
    return {
      page,
      ...(sessionId ? { sessionId } : {}),
      ...(result.data.updated !== undefined ? { updated: result.data.updated } : {}),
      ...(result.data.presentation ? { presentation: result.data.presentation } : {}),
    }
  }
  if (!record(part.output)) {
    return null
  }
  // An explicit failure must never be rescued by a contradictory direct or nested success.
  if (part.output.ok === false || part.output.isError === true) {
    return null
  }
  if (record(part.output.details) && (part.output.details.ok === false || part.output.details.isError === true)) {
    return null
  }
  const direct = parse(part.output)
  if (direct) {
    return direct
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
