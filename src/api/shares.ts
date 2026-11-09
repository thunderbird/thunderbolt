/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type HttpClient } from '@/contexts'
import type {
  ReceivedShareResponse,
  ShareRecipientCheckResponse,
  StoreShareRequest,
  StoreShareResponse,
} from '@shared/chat-shares'

/** Look emails up: each comes back shareable with its current inbox key, or unavailable. */
export const checkShareRecipients = async (
  httpClient: HttpClient,
  emails: string[],
): Promise<ShareRecipientCheckResponse> =>
  httpClient.post('shares/recipients/check', { json: { emails } }).json<ShareRecipientCheckResponse>()

/**
 * Store a chat's share, creating it or replacing it in place. A 409 carries a
 * `ShareConflictCode` saying what to do next.
 */
export const storeShare = async (
  httpClient: HttpClient,
  shareId: string,
  body: StoreShareRequest,
): Promise<StoreShareResponse> =>
  httpClient.post(`shares/${encodeURIComponent(shareId)}`, { json: body }).json<StoreShareResponse>()

/** One share sent to this account, with its snapshot. */
export const fetchReceivedShare = async (httpClient: HttpClient, shareId: string): Promise<ReceivedShareResponse> =>
  httpClient.get(`shares/${encodeURIComponent(shareId)}`).json<ReceivedShareResponse>()

/** Remove a chat someone shared with this account. */
export const deleteReceivedShare = async (httpClient: HttpClient, shareId: string): Promise<void> => {
  await httpClient.delete(`shares/received/${encodeURIComponent(shareId)}`)
}

/** Stop sharing: deletes the snapshot and every recipient's copy. */
export const deleteShare = async (httpClient: HttpClient, shareId: string): Promise<void> => {
  await httpClient.delete(`shares/${encodeURIComponent(shareId)}`)
}

/** Remove one person from a share. Removing the last one deletes the share. */
export const deleteShareRecipient = async (
  httpClient: HttpClient,
  shareId: string,
  recipientUserId: string,
): Promise<void> => {
  await httpClient.delete(`shares/${encodeURIComponent(shareId)}/recipients/${encodeURIComponent(recipientUserId)}`)
}
