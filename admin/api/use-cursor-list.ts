/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { Page } from '@shared/admin-api'
import { keepPreviousData, useInfiniteQuery, type QueryKey } from '@tanstack/react-query'

type UseCursorListOptions<T> = {
  queryKey: QueryKey
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>
  enabled?: boolean
}

/**
 * A cursor-paged admin list with "Load more": the pages so far, flattened, and `loadMore` for the
 * next one. `error` is the first page's or the latest next page's; a failed next page keeps the
 * items already loaded.
 *
 * The pages live under `[...queryKey, 'pages']`, never `queryKey` itself, so a plain `useQuery` on
 * the same key can't share the cache entry and its data shape. Invalidate the base key (or any
 * prefix, such as `adminQueryKeys.members.all`) to refresh both.
 */
export const useCursorList = <T>({ queryKey, fetchPage, enabled }: UseCursorListOptions<T>) => {
  const query = useInfiniteQuery({
    queryKey: [...queryKey, 'pages'],
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    // A new search keeps the last results on screen until its own arrive, instead of flashing empty.
    placeholderData: keepPreviousData,
  })
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  return {
    items,
    isLoading: query.isPending && query.fetchStatus !== 'idle',
    isEmpty: query.isSuccess && items.length === 0,
    error: query.error,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    refetch: () => void query.refetch(),
  }
}

export type CursorList<T> = ReturnType<typeof useCursorList<T>>
