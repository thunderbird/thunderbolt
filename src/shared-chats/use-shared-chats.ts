/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deleteReceivedShare, deleteShare, deleteShareRecipient } from '@/api/shares'
import { type HttpClient, useDatabase, useHttpClient } from '@/contexts'
import { getChatThreadTitles } from '@/dal/chat-threads'
import { getReceivedShares, getSentShares } from '@/dal/shares'
import type { ReceivedShareSummary } from '@shared/chat-shares'
import {
  decryptReceivedTitles,
  isShareGone,
  openReceivedShare,
  ShareContentInvalidError,
  ShareGoneError,
  ShareUnreadableError,
} from '@/services/shares'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery as useLiveQuery } from '@powersync/tanstack-react-query'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { type SentShare, titleCacheKey, toReceivedShareSummary, toSentShare, withTitles } from './share-rows'
import { waitForReceivedShareGone, waitForRecipientGone, waitForSentShareGone } from './synced-share-rows'

/**
 * Run a removal, treating "already gone" as done: the share was stopped, or the
 * person removed, on another device — which is the state the user asked for.
 */
const removeUnlessGone = async (remove: Promise<void>): Promise<void> => {
  try {
    await remove
  } catch (err) {
    if (!(await isShareGone(err))) {
      throw err
    }
  }
}

/** Decrypt received titles, logging a failure: the list then shows without them. */
const decryptTitlesLoggingFailures = async (httpClient: HttpClient, shares: ReceivedShareSummary[]) => {
  try {
    return await decryptReceivedTitles(httpClient, shares)
  } catch (err) {
    console.error('Decrypting shared chat titles failed', err)
    throw err
  }
}

/** Open a share, logging failures that are not about the share itself. */
const openLoggingFailures = async (httpClient: HttpClient, shareId: string) => {
  try {
    return await openReceivedShare(httpClient, shareId)
  } catch (err) {
    if (!(err instanceof ShareGoneError || err instanceof ShareUnreadableError)) {
      console.error(
        err instanceof ShareContentInvalidError ? 'A shared chat’s content is invalid' : 'Opening a shared chat failed',
        err,
      )
    }
    throw err
  }
}

const sharedChatsQueryKeys = {
  sent: ['shared-chats', 'sent'] as const,
  receivedRows: ['shared-chats', 'received', 'rows'] as const,
  receivedTitles: (titleKeys: string[]) => ['shared-chats', 'received', 'titles', ...titleKeys] as const,
  share: (shareId: string) => ['shared-chats', 'share', shareId] as const,
  localTitles: (ids: string[]) => ['shared-chats', 'local-titles', ...ids] as const,
}

export type { SentShare }

/**
 * What this account shared and with whom. A live query on the synced
 * `sent_shares` rows, so a change from any device shows up once it syncs. Local
 * reads run offline too (`networkMode: 'always'`).
 */
export const useSentShares = () => {
  const db = useDatabase()
  const { data, isPending, isError, isFetchedAfterMount } = useLiveQuery({
    queryKey: sharedChatsQueryKeys.sent,
    query: toCompilableQuery(getSentShares(db)),
    networkMode: 'always',
  })
  const shares = useMemo(() => data?.map(toSentShare), [data])
  return { data: shares, isPending, isError, isFetchedAfterMount }
}

/**
 * What was shared with this account: the synced `received_shares` rows, live,
 * with their titles decrypted on this device. Decrypting needs this account's
 * inbox keys from the backend; when they cannot be loaded, the rows still show,
 * without titles.
 */
export const useReceivedShares = () => {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const rowsQuery = useLiveQuery({
    queryKey: sharedChatsQueryKeys.receivedRows,
    query: toCompilableQuery(getReceivedShares(db)),
    networkMode: 'always',
  })
  const shares = useMemo(() => rowsQuery.data?.map(toReceivedShareSummary), [rowsQuery.data])
  const titlesQuery = useQuery({
    queryKey: sharedChatsQueryKeys.receivedTitles((shares ?? []).map(titleCacheKey)),
    queryFn: () => decryptTitlesLoggingFailures(httpClient, shares ?? []),
    enabled: shares !== undefined,
    placeholderData: keepPreviousData,
    // The key already covers everything a title depends on.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  // Titles already decrypted are kept through a failed or paused (offline) fetch; only a list
  // with none waits for the fetch to finish or fail.
  const hasTitlesOutcome = titlesQuery.data !== undefined || titlesQuery.isError || titlesQuery.fetchStatus === 'paused'
  const isDecryptingNewTitles = titlesQuery.isPlaceholderData && titlesQuery.fetchStatus === 'fetching'
  const data = shares && hasTitlesOutcome ? withTitles(shares, titlesQuery.data, isDecryptingNewTitles) : undefined
  return { data, isPending: !rowsQuery.isError && !data, isError: rowsQuery.isError }
}

/**
 * One shared chat, opened on this device. Fetched again on each visit: the
 * sharer can replace the snapshot, or stop sharing, at any time.
 */
export const useSharedChat = (shareId: string, enabled: boolean) => {
  const httpClient = useHttpClient()
  return useQuery({
    queryKey: sharedChatsQueryKeys.share(shareId),
    queryFn: () => openLoggingFailures(httpClient, shareId),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

/** Stop sharing a chat with everyone. */
export const useStopSharing = () => {
  const httpClient = useHttpClient()
  return useMutation({
    mutationFn: async (shareId: string) => {
      await removeUnlessGone(deleteShare(httpClient, shareId))
      await waitForSentShareGone(shareId)
    },
  })
}

/** Stop sharing a chat with one person. */
export const useRemoveShareRecipient = () => {
  const httpClient = useHttpClient()
  return useMutation({
    mutationFn: async ({ shareId, recipientUserId }: { shareId: string; recipientUserId: string }) => {
      await removeUnlessGone(deleteShareRecipient(httpClient, shareId, recipientUserId))
      await waitForRecipientGone(shareId, recipientUserId)
    },
  })
}

/** Remove a chat someone shared with you. */
export const useRemoveReceivedShare = () => {
  const httpClient = useHttpClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (shareId: string) => {
      await removeUnlessGone(deleteReceivedShare(httpClient, shareId))
      await waitForReceivedShareGone(shareId)
    },
    onSuccess: (_, shareId) => queryClient.removeQueries({ queryKey: sharedChatsQueryKeys.share(shareId) }),
  })
}

/**
 * Local titles of the chats you shared — the server only knows their ids. A
 * live query, so a rename or delete on any device shows up at once.
 */
export const useLocalChatTitles = (shares: SentShare[] | undefined) => {
  const db = useDatabase()
  const ids = [...new Set((shares ?? []).map((share) => share.chatThreadId))].sort()
  const { data } = useLiveQuery({
    queryKey: sharedChatsQueryKeys.localTitles(ids),
    query: toCompilableQuery(getChatThreadTitles(db, ids)),
    enabled: ids.length > 0,
    networkMode: 'always',
  })
  return new Map((data ?? []).map((row) => [row.id, row.title]))
}
