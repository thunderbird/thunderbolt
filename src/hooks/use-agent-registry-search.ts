/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react'
import { filterRegistry } from '@/lib/agent-registry-filter'
import type { RegistryEntry } from '@/types/registry'

/**
 * Owns the catalogue's search query and derives the filtered results during
 * render — no effect, since the results are pure state of `entries` + `query`.
 */
export const useAgentRegistrySearch = (entries: ReadonlyArray<RegistryEntry>) => {
  const [query, setQuery] = useState('')
  const results = useMemo(() => filterRegistry(entries, query), [entries, query])
  return { query, setQuery, results, isEmpty: results.length === 0 }
}
