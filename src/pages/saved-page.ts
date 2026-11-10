/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { PageChrome, PageDefinition } from '@shared/page-protocol'

export const savedPageKeyPrefix = 'saved-page:'
export const localSavedPageKeyPrefix = 'thunderbolt-local-page:'
export const maxSavedPageHtmlBytes = 2 * 1024 * 1024

export type SavedPage = PageDefinition & {
  version: 1
  chrome: PageChrome
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/)
const referenceIdentifier = z.string().min(1).max(500)
const webUrl = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => {
    if (Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      return false
    }
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    } catch {
      return false
    }
  }, 'A page must use an HTTP or HTTPS address without embedded credentials')

const pageSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: webUrl }),
  z.object({
    kind: z.literal('html'),
    html: z
      .string()
      .min(1)
      .max(maxSavedPageHtmlBytes)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= maxSavedPageHtmlBytes,
        'Saved HTML must be no larger than 2 MiB',
      ),
    artifact: z
      .object({
        messageId: referenceIdentifier.optional(),
        toolCallId: referenceIdentifier,
        chatThreadId: referenceIdentifier.nullable().optional(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal('local-app'), appId: referenceIdentifier, projectId: referenceIdentifier.optional() }),
])

const savedPageSchema = z.object({
  version: z.literal(1),
  id: identifier,
  title: z.string().trim().min(1).max(200),
  source: pageSourceSchema,
  chrome: z.enum(['browser', 'app']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
}) satisfies z.ZodType<SavedPage>

/** Keep source URLs and HTML in the encrypted value, never in a synced setting key. */
export const savedPageKey = (id: string): string => `${savedPageKeyPrefix}${identifier.parse(id)}`

/** Parse each stored page independently so one invalid entry cannot hide unrelated pins. */
export const parseSavedPage = (value: unknown): SavedPage | null => {
  try {
    const parsed = savedPageSchema.safeParse(typeof value === 'string' ? JSON.parse(value) : value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Build a durable shortcut from an already verified page, preserving the first pin date on updates. */
export const createSavedPage = (
  page: PageDefinition,
  chrome: PageChrome,
  previous?: SavedPage | null,
  now = new Date().toISOString(),
): SavedPage =>
  savedPageSchema.parse({
    ...page,
    title: page.title.trim().slice(0, 200),
    version: 1,
    chrome,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
  })

/** Deterministic insertion order survives sync without rewriting an entire pin list. */
export const sortSavedPages = (pages: readonly SavedPage[]): SavedPage[] =>
  [...pages]
    .filter((page) => page.deletedAt === null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
