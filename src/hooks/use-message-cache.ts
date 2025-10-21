import { getMessage, updateMessageCache } from '@/dal/chat-messages'
import { useQuery } from '@tanstack/react-query'

type UseMessageCacheOptions<T> = {
  /** The message ID to update */
  messageId: string
  /** Dot-notation path to the cache field (e.g., "linkPreviews.https://example.com") */
  cacheKey: string
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
 *   cacheKey: `linkPreviews.${url}`,
 *   fetchFn: () => fetchLinkPreview(url),
 * })
 * ```
 */
export const useMessageCache = <T>({ messageId, cacheKey, fetchFn }: UseMessageCacheOptions<T>) => {
  return useQuery({
    queryKey: ['messageCache', messageId, cacheKey],
    queryFn: async () => {
      // 1. Check DB for cached data
      const message = await getMessage(messageId)

      if (!message) {
        throw new Error(`Message ${messageId} not found`)
      }

      // Navigate the cache path to check for cached value
      // Only split on first dot to handle URLs properly
      const firstDotIndex = cacheKey.indexOf('.')

      let current: any = message.cache
      if (firstDotIndex === -1) {
        // No nested path
        current = current?.[cacheKey]
      } else {
        // Split into root key and sub key
        const rootKey = cacheKey.slice(0, firstDotIndex)
        const subKey = cacheKey.slice(firstDotIndex + 1)
        current = current?.[rootKey]?.[subKey]
      }

      // 2. If cached, return it
      if (current !== undefined && current !== null) {
        return current as T
      }

      // 3. Not cached - fetch and update DB
      const fetched = await fetchFn()
      await updateMessageCache(messageId, cacheKey, fetched)

      return fetched
    },
    staleTime: Infinity, // Once fetched, never refetch
    gcTime: Infinity, // Keep in cache forever
    retry: false, // Don't retry on failure
  })
}
