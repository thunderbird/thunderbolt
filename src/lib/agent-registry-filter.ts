/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { RegistryDistribution, RegistryEntry } from '@/types/registry'

/** A distribution kind we surface as a badge. `binary` covers any platform map. */
export type DistributionKind = 'npx' | 'uvx' | 'binary'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** Accepts a value only when it's an `http(s)` URL, dropping anything else to
 *  `undefined`. The registry is untrusted network data, so this keeps
 *  `javascript:` / `data:` payloads out of `<a href>` and `<img src>`. */
const asHttpUrl = (value: unknown): string | undefined =>
  typeof value === 'string' && /^https?:\/\//i.test(value) ? value : undefined

/** Parse the registry's `distribution` object, dropping anything malformed. */
const parseDistribution = (raw: unknown): RegistryDistribution => {
  if (!isRecord(raw)) {
    return {}
  }
  const distribution: RegistryDistribution = {}
  if (isRecord(raw.npx) && typeof raw.npx.package === 'string') {
    distribution.npx = { package: raw.npx.package, args: asStringArray(raw.npx.args) }
  }
  if (isRecord(raw.uvx) && typeof raw.uvx.package === 'string') {
    distribution.uvx = { package: raw.uvx.package, args: asStringArray(raw.uvx.args) }
  }
  if (isRecord(raw.binary)) {
    distribution.binary = raw.binary
  }
  return distribution
}

const parseEntry = (raw: unknown): RegistryEntry | null => {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    return null
  }
  return {
    id: raw.id,
    name: raw.name,
    version: typeof raw.version === 'string' ? raw.version : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    authors: asStringArray(raw.authors),
    license: typeof raw.license === 'string' ? raw.license : '',
    repository: asHttpUrl(raw.repository),
    website: asHttpUrl(raw.website),
    icon: asHttpUrl(raw.icon),
    distribution: parseDistribution(raw.distribution),
  }
}

/**
 * Defensively normalizes untrusted registry JSON (live CDN fetch or bundled
 * snapshot) into a typed `RegistryEntry[]`. Accepts either the raw registry
 * object (`{ agents: [...] }`) or a bare entry array; drops any entry missing an
 * `id` or `name`. This is the one place defensive parsing belongs — the input is
 * network data we don't control.
 */
export const parseRegistryJson = (raw: unknown): ReadonlyArray<RegistryEntry> => {
  const agents = Array.isArray(raw) ? raw : isRecord(raw) ? raw.agents : null
  if (!Array.isArray(agents)) {
    return []
  }
  return agents.map(parseEntry).filter((entry): entry is RegistryEntry => entry !== null)
}

/** The distribution kind to surface on a card, preferring npx > uvx > binary. */
export const primaryDistributionKind = (entry: RegistryEntry): DistributionKind | null => {
  if (entry.distribution.npx) {
    return 'npx'
  }
  if (entry.distribution.uvx) {
    return 'uvx'
  }
  if (entry.distribution.binary) {
    return 'binary'
  }
  return null
}

/** Human-readable badge label for a distribution kind. */
export const distributionLabel = (kind: DistributionKind): string => {
  switch (kind) {
    case 'npx':
      return 'Node.js'
    case 'uvx':
      return 'Python'
    case 'binary':
      return 'Binary'
  }
}

/**
 * Normalizes a raw search query for matching: trims surrounding whitespace and
 * lowercases so comparisons are case-insensitive.
 */
export const normalizeQuery = (q: string): string => q.trim().toLowerCase()

/**
 * Filters registry entries by a search query. An empty or whitespace-only query
 * returns every entry; otherwise entries whose name, description, id, or authors
 * contain the query (case-insensitive) are kept.
 *
 * Matching is plain substring containment with no ranking — by design, the
 * catalogue is small enough that relevance ordering adds no value.
 */
export const filterRegistry = (entries: ReadonlyArray<RegistryEntry>, query: string): ReadonlyArray<RegistryEntry> => {
  const normalized = normalizeQuery(query)
  if (normalized.length === 0) {
    return entries
  }
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(normalized) ||
      entry.description.toLowerCase().includes(normalized) ||
      entry.id.toLowerCase().includes(normalized) ||
      entry.authors.some((author) => author.toLowerCase().includes(normalized)),
  )
}
