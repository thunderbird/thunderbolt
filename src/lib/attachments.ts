/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultDeliveryMode, getTransformer } from '@/files/transformers'
import type { AttachmentData, ThunderboltUIMessage } from '@/types'
import { getAttachment, type StoredFile } from './file-blob-storage'

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
export const blobToBase64 = async (blob: Blob): Promise<string> => {
  const dataUrl = await blobToDataUrl(blob)
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

/** An attachment reference paired with its base64-encoded bytes. */
export type HydratedAttachment = AttachmentData & { base64: string }

/** Injectable IO for {@link hydrateAttachmentsAsFileParts} — overridden in tests to avoid IndexedDB/transformers. */
export type HydrationDeps = {
  getAttachment: typeof getAttachment
  getTransformer: typeof getTransformer
}

const defaultHydrationDeps: HydrationDeps = { getAttachment, getTransformer }

/** A `text` part carrying an attachment's extracted text, or just its name when there's no text to send. */
const attachmentTextPart = (filename: string, text?: string) => ({
  type: 'text' as const,
  text: text ? `[Attachment: ${filename}]\n\n${text}` : `[Attachment: ${filename}]`,
})

/**
 * Deliver a *current-turn* attachment in full (see {@link AttachmentData.deliverAs}):
 *   - default → AI SDK `file` part, bytes inlined as a data URL (e.g. an Anthropic
 *     PDF document block) — the native-first path. Plain-text files default to text.
 *   - `'text'` → run the text transformer and emit a `text` part instead (the
 *     convert-to-text remediation). Falls back to native bytes if no transformer.
 *   - `'images'` → rasterize (e.g. a scanned PDF) into one image `file` part per
 *     page for a vision model. Falls back to native bytes if no transformer.
 */
const hydrateCurrentAttachment = async (data: AttachmentData, file: StoredFile, deps: HydrationDeps) => {
  const mode = data.deliverAs ?? defaultDeliveryMode(data.mimeType)
  if (mode === 'text') {
    const transformer = await deps.getTransformer(data.mimeType, 'text')
    if (transformer) {
      const output = await transformer(file)
      if ('text' in output) {
        return [attachmentTextPart(data.filename, output.text)]
      }
    }
    // No text transformer — fall through to native bytes.
  }
  if (mode === 'images') {
    const transformer = await deps.getTransformer(data.mimeType, 'images')
    if (transformer) {
      const output = await transformer(file)
      if ('images' in output) {
        return output.images.map((image) => ({
          type: 'file' as const,
          mediaType: image.mimeType,
          filename: data.filename,
          url: image.dataUrl,
        }))
      }
    }
    // No images transformer — fall through to native bytes.
  }
  const url = await blobToDataUrl(file.blob)
  return [{ type: 'file' as const, mediaType: data.mimeType, filename: data.filename, url }]
}

/**
 * Reduce a *historical* attachment (from an earlier turn) to its extracted text,
 * or a bare `[Attachment: name]` reference when no text can be extracted (e.g. an
 * image). Historical attachments are NEVER re-sent as native bytes — see
 * {@link hydrateAttachmentsAsFileParts}.
 */
const hydrateHistoricalAttachment = async (data: AttachmentData, file: StoredFile, deps: HydrationDeps) => {
  const transformer = await deps.getTransformer(data.mimeType, 'text')
  if (transformer) {
    const output = await transformer(file)
    if ('text' in output) {
      return [attachmentTextPart(data.filename, output.text)]
    }
  }
  return [attachmentTextPart(data.filename)]
}

/**
 * Built-in (AI SDK) transport hydration: replace reference-only attachment parts
 * with their content so `convertToModelMessages` forwards them to the model.
 * Bytes are read from IndexedDB at send time — the persisted message keeps only
 * the reference. Attachments missing on this device are left as the reference
 * part (which `convertToModelMessages` drops from model input).
 *
 * Only the **latest user turn** delivers its attachments in full (native bytes /
 * images / extracted text). Attachments from **earlier** turns are reduced to
 * extracted text (or a `[Attachment: name]` reference) and are NEVER re-sent as
 * native bytes. Stateless chat resends the whole history every turn, so re-inlining
 * historical bytes both bloats each request and — critically — poisons the *entire
 * thread* if any one historical attachment is undeliverable (e.g. an image a model
 * rejects, which has no remediation path): the bad part replays forever and every
 * subsequent send fails. Reducing history to text removes the native bytes (so
 * nothing replays that can fail), keeps follow-up questions answerable, and shrinks
 * the payload. The current turn still gets full fidelity, and remediation still
 * operates on it.
 */
export const hydrateAttachmentsAsFileParts = async (
  messages: ThunderboltUIMessage[],
  deps: HydrationDeps = defaultHydrationDeps,
): Promise<ThunderboltUIMessage[]> => {
  const currentTurnIndex = messages.findLastIndex((message) => message.role === 'user')
  return Promise.all(
    messages.map(async (message, index) => {
      if (!message.parts.some(isAttachmentPart)) {
        return message
      }
      const isCurrentTurn = index === currentTurnIndex
      // Each attachment maps to one or more parts (images yield one part per
      // page), so build arrays and flatten.
      const nested = await Promise.all(
        message.parts.map(async (part) => {
          if (!isAttachmentPart(part)) {
            return [part]
          }
          const file = await deps.getAttachment(part.data.localFileId)
          if (!file) {
            return [part]
          }
          return isCurrentTurn
            ? hydrateCurrentAttachment(part.data, file, deps)
            : hydrateHistoricalAttachment(part.data, file, deps)
        }),
      )
      return { ...message, parts: nested.flat() }
    }),
  )
}
