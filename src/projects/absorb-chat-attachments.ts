/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Absorbs files attached in a project's chats into that project's knowledge.
 *
 * There is one place to pick a file — the chat composer — and if the chat belongs
 * to a project, the document also becomes part of the project. The project page
 * therefore has no uploader of its own; it aggregates what the conversations
 * brought in.
 *
 * The bytes stay exactly where they were: device-local in IndexedDB, attached to
 * the message. What lands in the project is the *extracted text*, which is the
 * only form that can sync (see `projectFilesTable`). So the same file ends up in
 * two representations serving two purposes — native bytes for this turn's model
 * call, synced text for every future chat in the project.
 */

import { getAttachment } from '@/lib/file-blob-storage'
import { getChatMessages } from '@/dal/chat-messages'
import { getProjectFiles, addProjectFile } from '@/dal/projects'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getAttachments } from '@/lib/attachments'
import type { AttachmentData, ThunderboltUIMessage } from '@/types'
import { canExtractKnowledgeText, extractKnowledgeText, maxKnowledgeChars } from './extract-knowledge-text'

/**
 * The attachments worth absorbing from a save.
 *
 * Scoped to the newest user turn, not every message: the save on send carries
 * the *whole* conversation (see `chat-instance.ts`), so scanning all of it would
 * re-read and re-extract every earlier attachment on every subsequent message —
 * parsing the same PDF once per turn. New attachments only ever arrive on the
 * newest user message, and each earlier turn was absorbed by its own save.
 */
export const attachmentsToAbsorb = (
  messages: readonly { role: string; parts: ThunderboltUIMessage['parts'] }[],
): AttachmentData[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user') {
      return getAttachments(message as ThunderboltUIMessage)
    }
  }
  return []
}

/**
 * Absorb everything already attached in an existing chat.
 *
 * Needed because absorption normally runs at message-save time, when the chat's
 * project is whatever it was *then*. A chat that is moved into a project
 * afterwards — the common case: start a chat, attach a file, then decide it
 * belongs to a project — would otherwise leave its documents behind.
 *
 * Unlike the save path this walks **every** message, not just the newest turn:
 * the whole point is to back-fill a conversation's history.
 */
export const absorbExistingChatAttachments = async (
  db: AnyDrizzleDatabase,
  projectId: string,
  chatThreadId: string,
  deps: AbsorbDeps = defaultDeps,
): Promise<AbsorbResult> => {
  const messages = await getChatMessages(db, chatThreadId)
  const attachments = messages.flatMap((message) =>
    getAttachments(convertDbChatMessageToUIMessage(message) as ThunderboltUIMessage),
  )
  return absorbChatAttachments(db, projectId, attachments, deps)
}

/**
 * Injectable blob reader. Tests pass a fake rather than `mock.module`-ing
 * `@/lib/file-blob-storage`: that module is imported by ~15 files, and bun
 * installs module mocks for the whole worker — so stubbing it leaks into every
 * later test file in the process ("passes alone, fails together"), and a partial
 * stub leaves the module's other exports undefined.
 */
export type AbsorbDeps = { getAttachment: typeof getAttachment }

const defaultDeps: AbsorbDeps = { getAttachment }

export type AbsorbResult = {
  /** Filenames added to the project's knowledge. */
  added: string[]
  /** Already present (same name and same text) — re-attaching is idempotent. */
  duplicates: string[]
  /** No text form, e.g. an image. Still a normal chat attachment. */
  unsupported: string[]
}

/**
 * Add every attachment that can become text to the project's knowledge.
 *
 * Idempotent by (filename, content): sending the same PDF in three messages adds
 * one document, and re-sending after an edit adds the new version rather than
 * silently keeping the stale one.
 *
 * Never throws. A failure here must not fail the user's message — the file is
 * still delivered to the model either way, so absorption is best-effort.
 */
export const absorbChatAttachments = async (
  db: AnyDrizzleDatabase,
  projectId: string,
  attachments: readonly AttachmentData[],
  deps: AbsorbDeps = defaultDeps,
): Promise<AbsorbResult> => {
  const result: AbsorbResult = { added: [], duplicates: [], unsupported: [] }
  if (attachments.length === 0) {
    return result
  }

  const existing = await getProjectFiles(db, projectId)

  for (const attachment of attachments) {
    if (!canExtractKnowledgeText(attachment.mimeType, attachment.filename)) {
      result.unsupported.push(attachment.filename)
      continue
    }
    try {
      const stored = await deps.getAttachment(attachment.localFileId)
      if (!stored) {
        // Bytes live on the device that attached them; on another device the
        // reference resolves to nothing. Skip quietly — the text was absorbed
        // wherever the upload happened and syncs from there.
        continue
      }
      const content = (await extractKnowledgeText(stored)).trim().slice(0, maxKnowledgeChars)
      if (content.length === 0) {
        result.unsupported.push(attachment.filename)
        continue
      }
      const alreadyPresent = existing.some((file) => file.filename === attachment.filename && file.content === content)
      if (alreadyPresent) {
        result.duplicates.push(attachment.filename)
        continue
      }
      await addProjectFile(db, {
        projectId,
        filename: attachment.filename,
        sourceMimeType: attachment.mimeType,
        content,
        origin: 'chat',
      })
      result.added.push(attachment.filename)
    } catch {
      // Extraction failed (corrupt PDF, unreadable blob). The message still sends.
      result.unsupported.push(attachment.filename)
    }
  }

  return result
}
