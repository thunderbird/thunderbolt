/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AttachmentData, ThunderboltUIMessage } from '@/types'
import { getAttachment } from './file-blob-storage'

/**
 * The AI SDK `data-*` part type for a chat attachment reference. The part holds
 * only the {@link AttachmentData} reference — never the file bytes — so it
 * persists/syncs cheaply and `convertToModelMessages` ignores it (data parts
 * are UI-only). At send time the per-agent transport hydrates the bytes from
 * IndexedDB.
 */
export const attachmentPartType = 'data-attachment' as const

export type AttachmentPart = {
  type: typeof attachmentPartType
  id?: string
  data: AttachmentData
}

/** Build the reference-only attachment part to include in an outgoing message. */
export const buildAttachmentPart = (data: AttachmentData): AttachmentPart => ({
  type: attachmentPartType,
  data,
})

/** Type guard for attachment parts. */
export const isAttachmentPart = (part: { type: string }): part is AttachmentPart => part.type === attachmentPartType

/** Extract all attachment references from a message, in order. */
export const getAttachments = (message: ThunderboltUIMessage): AttachmentData[] =>
  message.parts.filter(isAttachmentPart).map((part) => part.data)

/** Read a Blob as a base64 data URL. */
const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment'))
    reader.readAsDataURL(blob)
  })

/**
 * Built-in (AI SDK) transport hydration: replace reference-only attachment
 * parts with AI SDK `file` parts whose bytes are inlined as a data URL, so
 * `convertToModelMessages` forwards them to the model (e.g. an Anthropic PDF
 * document block). Bytes are read from IndexedDB at send time — the persisted
 * message keeps only the reference. Attachments missing on this device are left
 * as the reference part (which `convertToModelMessages` drops from model input).
 */
export const hydrateAttachmentsAsFileParts = async (
  messages: ThunderboltUIMessage[],
): Promise<ThunderboltUIMessage[]> =>
  Promise.all(
    messages.map(async (message) => {
      if (!message.parts.some(isAttachmentPart)) {
        return message
      }
      const parts = await Promise.all(
        message.parts.map(async (part) => {
          if (!isAttachmentPart(part)) {
            return part
          }
          const file = await getAttachment(part.data.localFileId)
          if (!file) {
            return part
          }
          const url = await blobToDataUrl(file.blob)
          return { type: 'file' as const, mediaType: part.data.mimeType, filename: part.data.filename, url }
        }),
      )
      return { ...message, parts }
    }),
  )
