/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultDeliveryMode, getTransformer } from '@/files/transformers'
import { blobToBase64, isAttachmentPart } from '@/lib/attachments'
import { getAttachment, type StoredFile } from '@/lib/file-blob-storage'
import { hydrateQuotesAsText } from '@/lib/quotes'
import type { ThunderboltUIMessage } from '@/types'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { SeedTurn } from '@shared/agent-core'

export type BuiltInConversationDeps = {
  readonly getAttachment: typeof getAttachment
  readonly getTransformer: typeof getTransformer
  readonly blobToBase64: typeof blobToBase64
}

const defaultDeps: BuiltInConversationDeps = { getAttachment, getTransformer, blobToBase64 }

export type BuiltInPrompt = {
  readonly text: string
  readonly images: ImageContent[]
}

export type PreparedBuiltInConversation = {
  readonly history: SeedTurn[]
  readonly prompt: BuiltInPrompt
}

type PreparedPart = {
  readonly text: string
  readonly images: ImageContent[]
}

/** Label attachment content in plain-text conversation history. */
const attachmentText = (filename: string, text?: string): string =>
  text ? `[Attachment: ${filename}]\n\n${text}` : `[Attachment: ${filename}]`

/** Convert transformer data URL to Pi's raw-base64 image shape. */
const imageFromDataUrl = (mimeType: string, dataUrl: string): ImageContent => ({
  type: 'image',
  mimeType,
  data: dataUrl.slice(dataUrl.indexOf(',') + 1),
})

/** Extract attachment text when a transformer supports its MIME type. */
const extractAttachmentText = async (
  file: StoredFile,
  mimeType: string,
  deps: BuiltInConversationDeps,
): Promise<string | null> => {
  const transformer = await deps.getTransformer(mimeType, 'text')
  const output = transformer ? await transformer(file) : null
  return output && 'text' in output ? output.text : null
}

/** Map one attachment reference to Pi-supported prompt text and image blocks. */
const prepareAttachment = async (
  part: Extract<ThunderboltUIMessage['parts'][number], { type: 'data-attachment' }>,
  isCurrentTurn: boolean,
  deps: BuiltInConversationDeps,
): Promise<PreparedPart> => {
  const { filename, localFileId, mimeType, deliverAs } = part.data
  const file = await deps.getAttachment(localFileId)
  if (!file) {
    return { text: `${attachmentText(filename)} (file unavailable on this device)`, images: [] }
  }

  if (!isCurrentTurn) {
    const text = await extractAttachmentText(file, mimeType, deps)
    return {
      text: attachmentText(filename, text ?? undefined),
      images: [],
    }
  }

  const mode = deliverAs ?? defaultDeliveryMode(mimeType)
  if (mode === 'images') {
    const transformer = await deps.getTransformer(mimeType, 'images')
    const output = transformer ? await transformer(file) : null
    if (output && 'images' in output) {
      return {
        text: attachmentText(filename),
        images: output.images.map((image) => imageFromDataUrl(image.mimeType, image.dataUrl)),
      }
    }
  }

  if (mode === 'text') {
    const text = await extractAttachmentText(file, mimeType, deps)
    if (text !== null) {
      return { text: attachmentText(filename, text), images: [] }
    }
  }

  if (mimeType.startsWith('image/')) {
    return {
      text: attachmentText(filename),
      images: [{ type: 'image', mimeType, data: await deps.blobToBase64(file.blob) }],
    }
  }

  // Pi has no native document/file content block. Prefer local text extraction
  // for PDF/docx even when legacy delivery would send raw bytes.
  const text = mode === 'text' ? null : await extractAttachmentText(file, mimeType, deps)
  if (text !== null) {
    return { text: attachmentText(filename, text), images: [] }
  }
  return { text: `${attachmentText(filename)} (file type unsupported by built-in agent)`, images: [] }
}

/** Convert one UI message to Pi-compatible text/images while preserving part order. */
const prepareMessage = async (
  message: ThunderboltUIMessage,
  isCurrentTurn: boolean,
  deps: BuiltInConversationDeps,
): Promise<PreparedPart> => {
  const hydrated = hydrateQuotesAsText([message])[0]
  const parts = await Promise.all(
    hydrated.parts.map(async (part): Promise<PreparedPart> => {
      if (part.type === 'text') {
        return { text: part.text, images: [] }
      }
      if (isAttachmentPart(part)) {
        return prepareAttachment(part, isCurrentTurn, deps)
      }
      return { text: '', images: [] }
    }),
  )
  return {
    text: parts
      .map((part) => part.text)
      .filter(Boolean)
      .join('\n'),
    images: parts.flatMap((part) => part.images),
  }
}

/** Collapse consecutive same-role seed turns to satisfy provider alternation. */
const coalesceTurns = (turns: readonly SeedTurn[]): SeedTurn[] =>
  turns.reduce<SeedTurn[]>((acc, turn) => {
    const previous = acc.at(-1)
    if (previous?.role === turn.role) {
      acc[acc.length - 1] = { role: turn.role, text: `${previous.text}\n\n${turn.text}` }
      return acc
    }
    acc.push(turn)
    return acc
  }, [])

/** Prepare prior text history plus latest Pi-native prompt content. */
export const prepareBuiltInConversation = async (
  messages: ThunderboltUIMessage[],
  skillInstructions: string[] | undefined,
  deps: BuiltInConversationDeps = defaultDeps,
): Promise<PreparedBuiltInConversation> => {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  if (lastUserIndex === -1) {
    throw new Error('Built-in adapter: no user message in request body')
  }

  const priorTurns = await Promise.all(
    messages.slice(0, lastUserIndex).map(async (message): Promise<SeedTurn | null> => {
      if (message.role !== 'user' && message.role !== 'assistant') {
        return null
      }
      const prepared = await prepareMessage(message, false, deps)
      return prepared.text.length > 0 ? { role: message.role, text: prepared.text } : null
    }),
  )
  const current = await prepareMessage(messages[lastUserIndex], true, deps)
  const turns = coalesceTurns([
    ...priorTurns.filter((turn): turn is SeedTurn => turn !== null),
    { role: 'user', text: current.text },
  ])
  const promptTurn = turns.at(-1)
  if (!promptTurn) {
    throw new Error('Built-in adapter: current user message has no supported content')
  }
  const skillPrefix = skillInstructions?.length ? `${skillInstructions.join('\n\n')}\n\n` : ''
  return {
    history: turns.slice(0, -1),
    prompt: { text: `${skillPrefix}${promptTurn.text}`, images: current.images },
  }
}
