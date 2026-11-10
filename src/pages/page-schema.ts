/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { PageDefinition } from '@shared/page-protocol'

export const maxPageHtmlBytes = 2 * 1024 * 1024
export const maxPageTitleLength = 200
export const pageIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/)
export const pageReferenceSchema = z.string().min(1).max(500)
export const pageUrlSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => {
    if (value === 'about:blank') {
      return true
    }
    if (Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      return false
    }
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    } catch {
      return false
    }
  }, 'Use an absolute HTTP or HTTPS URL without embedded credentials, or about:blank.')

/** Apply the same trust boundary to tool results, agent input, and saved page records. */
export const pageDefinitionSchema = z.object({
  id: pageIdentifierSchema,
  title: z.string().max(maxPageTitleLength),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('url'), url: pageUrlSchema }),
    z.object({
      kind: z.literal('html'),
      html: z
        .string()
        .min(1)
        .max(maxPageHtmlBytes)
        .refine(
          (value) => new TextEncoder().encode(value).byteLength <= maxPageHtmlBytes,
          'HTML pages must be no larger than 2 MiB',
        ),
      artifact: z
        .object({
          toolCallId: pageReferenceSchema,
          messageId: pageReferenceSchema.optional(),
          chatThreadId: pageReferenceSchema.nullable().optional(),
        })
        .optional(),
    }),
    z.object({ kind: z.literal('local-app'), appId: pageReferenceSchema, projectId: pageReferenceSchema.optional() }),
  ]),
}) satisfies z.ZodType<PageDefinition>
