/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getChatMessages } from '@/dal/chat-messages'
import { getDb } from '@/db/database'
import { isAttachmentPart } from '@/lib/attachments'
import { getAttachment, type StoredFile } from '@/lib/file-blob-storage'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { UIMessage } from 'ai'
import { isOfficeScriptPart, officeScriptFiles } from './office-script-tool'

/** Ids of the stored files a thread's messages point to, oldest first: the user's attachments and this tool's files. */
export const threadFileIds = (messages: UIMessage[]): string[] => [
  ...new Set(
    messages.flatMap(({ parts }) =>
      parts.flatMap((part) => {
        if (isAttachmentPart(part)) {
          return [part.data.localFileId]
        }
        return isOfficeScriptPart(part) ? (officeScriptFiles(part) ?? []).map(({ id }) => id) : []
      }),
    ),
  ),
]

/**
 * The stored files of a chat thread that are on this device. Only these are a script's inputs, so a script never
 * reads another chat's files.
 */
export const loadThreadFiles = async (chatThreadId: string): Promise<StoredFile[]> => {
  const ids = threadFileIds((await getChatMessages(getDb(), chatThreadId)).map(convertDbChatMessageToUIMessage))
  const files = await Promise.all(ids.map(getAttachment))
  return files.filter((file) => file !== null)
}
