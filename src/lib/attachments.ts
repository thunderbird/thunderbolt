/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getTransformer } from '@/files/transformers'
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

/** Read a Blob as raw base64 (no `data:<mime>;base64,` prefix). */
const blobToBase64 = async (blob: Blob): Promise<string> => {
  const dataUrl = await blobToDataUrl(blob)
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

/** An attachment reference paired with its base64-encoded bytes. */
export type HydratedAttachment = AttachmentData & { base64: string }

/**
 * Read each attachment's bytes from IndexedDB as raw base64, dropping any not
 * present on this device. Transport-agnostic: callers that inline file bytes
 * (e.g. the ACP embedded-`resource` transport) assemble their own wire shape
 * from the result.
 */
export const hydrateAttachmentsAsBase64 = async (attachments: AttachmentData[]): Promise<HydratedAttachment[]> => {
  const hydrated = await Promise.all(
    attachments.map(async (attachment) => {
      const file = await getAttachment(attachment.localFileId)
      return file ? { ...attachment, base64: await blobToBase64(file.blob) } : null
    }),
  )
  return hydrated.filter((entry): entry is HydratedAttachment => entry !== null)
}

/**
 * Built-in (AI SDK) transport hydration: replace reference-only attachment
 * parts with the bytes (or extracted text) so `convertToModelMessages` forwards
 * them to the model. Bytes are read from IndexedDB at send time — the persisted
 * message keeps only the reference. Attachments missing on this device are left
 * as the reference part (which `convertToModelMessages` drops from model input).
 *
 * Delivery per attachment (see {@link AttachmentData.deliverAs}):
 *   - default → AI SDK `file` part, bytes inlined as a data URL (e.g. an
 *     Anthropic PDF document block) — the native-first path.
 *   - `'text'` → run the client-side transformer and emit a `text` part instead
 *     (the "convert to text & retry" remediation for models that can't read the
 *     native file). Falls back to the file part if no transformer is registered.
 */
export const hydrateAttachmentsAsFileParts = async (
  messages: ThunderboltUIMessage[],
): Promise<ThunderboltUIMessage[]> =>
  Promise.all(
    messages.map(async (message) => {
      if (!message.parts.some(isAttachmentPart)) {
        return message
      }
      // Each attachment maps to one or more parts (images yield one part per
      // page), so build arrays and flatten.
      const nested = await Promise.all(
        message.parts.map(async (part) => {
          if (!isAttachmentPart(part)) {
            return [part]
          }
          const file = await getAttachment(part.data.localFileId)
          if (!file) {
            return [part]
          }
          if (part.data.deliverAs === 'text') {
            const transformer = await getTransformer(part.data.mimeType, 'text')
            if (transformer) {
              const output = await transformer(file)
              if ('text' in output) {
                return [{ type: 'text' as const, text: `[Attachment: ${part.data.filename}]\n\n${output.text}` }]
              }
            }
            // No text transformer — fall through to native bytes.
          }
          if (part.data.deliverAs === 'images') {
            const transformer = await getTransformer(part.data.mimeType, 'images')
            if (transformer) {
              const output = await transformer(file)
              if ('images' in output) {
                return output.images.map((image) => ({
                  type: 'file' as const,
                  mediaType: image.mimeType,
                  filename: part.data.filename,
                  url: image.dataUrl,
                }))
              }
            }
            // No images transformer — fall through to native bytes.
          }
          const url = await blobToDataUrl(file.blob)
          return [{ type: 'file' as const, mediaType: part.data.mimeType, filename: part.data.filename, url }]
        }),
      )
      return { ...message, parts: nested.flat() }
    }),
  )
