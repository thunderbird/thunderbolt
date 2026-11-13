/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { useMemo, useRef } from 'react'

type ThreadSourcesEntry = {
  own: SourceMetadata[] | undefined
  inherited: SourceMetadata[] | undefined
  result: SourceMetadata[] | undefined
}

const mergeSources = (
  inherited: SourceMetadata[] | undefined,
  own: SourceMetadata[] | undefined,
): SourceMetadata[] | undefined => {
  if (!own?.length) {
    return inherited
  }
  if (!inherited?.length) {
    return own
  }
  return [...inherited, ...own]
}

/**
 * Resolve, per assistant message, the sources its `[N]` citations may refer to: its
 * own `metadata.sources` plus those of every earlier assistant message in the thread.
 * Each message stores only the sources its own turn registered, but the model keeps
 * the whole history and cites earlier numbers in follow-ups, so the lookup is built
 * here at render time instead of copying the growing list onto every message.
 *
 * Entries are cached per message id and reused while their inputs are referentially
 * unchanged, so the streaming last message does not hand settled messages new arrays
 * (which would defeat their memoization) on every token.
 */
export const useThreadSources = (
  messages: readonly ThunderboltUIMessage[],
): ReadonlyMap<string, SourceMetadata[] | undefined> => {
  const cache = useRef(new Map<string, ThreadSourcesEntry>())

  return useMemo(() => {
    const nextCache = new Map<string, ThreadSourcesEntry>()
    const resolved = new Map<string, SourceMetadata[] | undefined>()
    let inherited: SourceMetadata[] | undefined

    for (const message of messages) {
      if (message.role !== 'assistant') {
        continue
      }
      const own = message.metadata?.sources
      const cached = cache.current.get(message.id)
      const entry: ThreadSourcesEntry =
        cached && cached.own === own && cached.inherited === inherited
          ? cached
          : { own, inherited, result: mergeSources(inherited, own) }
      nextCache.set(message.id, entry)
      resolved.set(message.id, entry.result)
      inherited = entry.result
    }

    cache.current = nextCache
    return resolved
  }, [messages])
}
