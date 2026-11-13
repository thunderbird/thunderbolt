/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getChatMessages } from '@/dal/chat-messages'
import { getDb } from '@/db/database'
import { isAttachmentPart } from '@/lib/attachments'
import { getAttachment } from '@/lib/file-blob-storage'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { UIMessage } from 'ai'
import { isOfficeScriptPart, officeScriptFiles } from './office-script-tool'
import type { ThreadFile } from './script-inputs'

/**
 * The stored files a thread's messages point to, oldest first: the user's attachments and this tool's files, each
 * of the tool's with the name the script gave it, even when the user attached it again.
 */
export const threadFileRefs = (messages: UIMessage[]): { id: string; savedAs?: string }[] => {
  const savedAs = new Map<string, string | undefined>()
  for (const part of messages.flatMap(({ parts }) => parts)) {
    if (isAttachmentPart(part)) {
      savedAs.set(part.data.localFileId, savedAs.get(part.data.localFileId))
    } else if (isOfficeScriptPart(part)) {
      for (const file of officeScriptFiles(part) ?? []) {
        savedAs.set(file.id, file.savedAs)
      }
    }
  }
  return [...savedAs].map(([id, name]) => ({ id, savedAs: name }))
}

/**
 * The stored files of a chat thread that are on this device. Only these are a script's inputs, so a script never
 * reads another chat's files.
 */
export const loadThreadFiles = async (chatThreadId: string): Promise<ThreadFile[]> => {
  const refs = threadFileRefs((await getChatMessages(getDb(), chatThreadId)).map(convertDbChatMessageToUIMessage))
  const files = await Promise.all(
    refs.map(async ({ id, savedAs }) => {
      const file = await getAttachment(id)
      return file && { ...file, savedAs }
    }),
  )
  return files.filter((file) => file !== null)
}
