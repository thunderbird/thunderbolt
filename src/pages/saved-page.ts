/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { PageChrome, PageDefinition } from '@shared/page-protocol'
import { maxPageHtmlBytes, maxPageTitleLength, pageDefinitionSchema, pageIdentifierSchema } from './page-schema'

export const savedPageKeyPrefix = 'saved-page:'
export const localSavedPageKeyPrefix = 'thunderbolt-local-page:'
export const maxSavedPageHtmlBytes = maxPageHtmlBytes

export type SavedPage = PageDefinition & {
  version: 1
  chrome: PageChrome
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

const savedPageSchema = pageDefinitionSchema
  .extend({
    version: z.literal(1),
    title: z.string().trim().min(1).max(maxPageTitleLength),
    chrome: z.enum(['browser', 'app']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (page) => page.source.kind !== 'url' || page.source.url !== 'about:blank',
    'Blank pages cannot be pinned',
  ) satisfies z.ZodType<SavedPage>

/** Keep source URLs and HTML in the encrypted value, never in a synced setting key. */
export const savedPageKey = (id: string): string => `${savedPageKeyPrefix}${pageIdentifierSchema.parse(id)}`

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
    title: page.title.trim().slice(0, maxPageTitleLength),
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
