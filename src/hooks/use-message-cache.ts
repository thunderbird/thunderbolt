/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getMessage, updateMessageCache } from '@/dal/chat-messages'
import { useSharedChatSnapshot } from '@/shared-chats/snapshot-context'
import { useQuery } from '@tanstack/react-query'

type UseMessageCacheOptions<T> = {
  /** The message ID to update */
  messageId: string
  /** Array-based cache key (e.g., ['linkPreview', url] or ['weatherForecast', location, region]) - uses camelCase for namespace */
  cacheKey: string[]
  /** Function to fetch the value if not cached */
  fetchFn: () => Promise<T>
  /** Whether the query should run. Defaults to true */
  enabled?: boolean
  /**
   * In a shared chat, the leading part of `cacheKey` that names the data
   * rather than how this viewer wants it shown. The weather key ends in the
   * viewer's unit and locale, which a recipient rarely shares with the sharer,
   * so their entry is found by this prefix instead.
   */
  snapshotCacheKey?: string[]
}

/**
 * The entry the sharer's message stored under `storageKey`, else the first
 * stored under `prefix`. A shared chat is a frozen copy: what was not stored is
 * not fetched on the recipient's behalf, so a miss is `null`.
 */
export const readSnapshotEntry = (
  cache: Record<string, unknown> | undefined,
  storageKey: string,
  prefix: string[] | undefined,
): unknown => {
  if (!cache) {
    return null
  }
  if (cache[storageKey] != null) {
    return cache[storageKey]
  }
  const prefixKey = prefix ? `${prefix.join('/')}/` : null
  const match = prefixKey ? Object.keys(cache).find((key) => key.startsWith(prefixKey)) : undefined
  return match ? (cache[match] ?? null) : null
}

/**
 * Hook for lazy enrichment of message data.
 *
 * Strategy:
 * 1. Check DB for cached data in message.cache column
 * 2. If cached → return immediately (no external fetch)
 * 3. If not cached → fetch via fetchFn, update DB, return
 * 4. React Query caches in memory for rest of session
 *
 * In a shared chat the message is not in the local database: the value comes
 * from the cache the sharer's message carried, is never fetched and never
 * written, and is `null` when the snapshot has none.
 *
 * @example
 * ```tsx
 * const { data, isLoading } = useMessageCache({
 *   messageId: message.id,
 *   cacheKey: ['linkPreview', url],
 *   fetchFn: () => fetchLinkPreview(url),
 * })
 * ```
 */
export const useMessageCache = <T>({
  messageId,
  cacheKey,
  fetchFn,
  enabled = true,
  snapshotCacheKey,
}: UseMessageCacheOptions<T>) => {
  const db = useDatabase()
  const snapshot = useSharedChatSnapshot()
  const storageKey = cacheKey.join('/')

  const readFromDatabase = async () => {
    // 1. Check DB for cached data
    const message = await getMessage(db, messageId)

    if (!message) {
      throw new Error(`Message ${messageId} not found`)
    }

    // 2. Check if value is cached
    const cache = message.cache as Record<string, unknown> | null | undefined
    const cached = cache?.[storageKey]

    if (cached !== undefined && cached !== null) {
      return cached as T
    }

    // 3. Not cached - fetch and update DB
    const fetched = await fetchFn()
    await updateMessageCache(db, messageId, storageKey, fetched)

    return fetched
  }

  // Values from another account's snapshot are cast like the database's are;
  // the shared transcript's per-message error boundary contains a malformed one.
  const readFromSnapshot = async () =>
    readSnapshotEntry(snapshot?.cache.get(messageId), storageKey, snapshotCacheKey) as T | null

  return useQuery({
    queryKey: snapshot
      ? ['sharedChatCache', snapshot.shareId, snapshot.version, messageId, ...cacheKey]
      : ['messageCache', messageId, ...cacheKey],
    queryFn: snapshot ? readFromSnapshot : readFromDatabase,
    enabled,
    staleTime: Infinity, // Once fetched, never refetch
    gcTime: Infinity, // Keep in cache forever
    retry: false, // Don't retry on failure
  })
}
