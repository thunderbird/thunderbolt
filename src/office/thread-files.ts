/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getChatMessages } from '@/dal/chat-messages'
import { getDb } from '@/db/database'
import { isAttachmentPart } from '@/lib/attachments'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { UIMessage } from 'ai'
import { isOfficeScriptPart, officeScriptFiles } from './office-script-tool'
import type { ThreadFile } from './script-inputs'

/**
 * The files a thread's messages point to, oldest first: the user's attachments and this tool's files, each of the
 * tool's with the name the script gave it and its size, even when the user attached it again. Nothing is read from
 * the attachment store, so a file may not be on this device.
 */
export const threadFileRefs = (messages: UIMessage[]): ThreadFile[] => {
  const files = new Map<string, ThreadFile>()
  for (const part of messages.flatMap(({ parts }) => parts)) {
    if (isAttachmentPart(part)) {
      const { localFileId: id, filename } = part.data
      files.set(id, files.get(id) ?? { id, filename })
    } else if (isOfficeScriptPart(part)) {
      for (const { id, filename, savedAs, size } of officeScriptFiles(part) ?? []) {
        files.set(id, { id, filename, savedAs, size })
      }
    }
  }
  return [...files.values()]
}

/** The files of a chat thread. Only these are a script's inputs, so a script never reads another chat's files. */
export const loadThreadFiles = async (chatThreadId: string): Promise<ThreadFile[]> =>
  threadFileRefs((await getChatMessages(getDb(), chatThreadId)).map(convertDbChatMessageToUIMessage))
