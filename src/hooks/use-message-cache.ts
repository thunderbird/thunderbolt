import { getMessage, updateMessageCache } from '@/dal/chat-messages'
import { useQuery } from '@tanstack/react-query'

type UseMessageCacheOptions<T> = {
  /** The message ID to update */
  messageId: string
  /** Array-based cache key (e.g., ['linkPreview', url] or ['weatherForecast', location, region]) - uses camelCase for namespace */
  cacheKey: string[]
  /** Function to fetch the value if not cached */
  fetchFn: () => Promise<T>
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
 * @example
 * ```tsx
 * const { data, isLoading } = useMessageCache({
 *   messageId: message.id,
 *   cacheKey: ['linkPreview', url],
 *   fetchFn: () => fetchLinkPreview(url),
 * })
 * ```
 */
export const useMessageCache = <T>({ messageId, cacheKey, fetchFn }: UseMessageCacheOptions<T>) => {
  const storageKey = cacheKey.join('/')

  return useQuery({
    queryKey: ['messageCache', messageId, ...cacheKey],
    queryFn: async () => {
      // 1. Check DB for cached data
      const message = await getMessage(messageId)

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
      await updateMessageCache(messageId, storageKey, fetched)

      return fetched
    },
    staleTime: Infinity, // Once fetched, never refetch
    gcTime: Infinity, // Keep in cache forever
    retry: false, // Don't retry on failure
  })
}
