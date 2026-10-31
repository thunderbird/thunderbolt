/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { csvToTsv, toTsv } from '@/files/tabular'
import { defaultDeliveryMode, getTransformer, isPlainTextMime, xlsxMime } from '@/files/transformers'
import { readXlsxSheets } from '@/files/transformers/xlsx-to-text'
import { blobToBase64, isAttachmentPart } from '@/lib/attachments'
import { getAttachment, type StoredFile } from '@/lib/file-blob-storage'
import { hydrateQuotesAsText } from '@/lib/quotes'
import type { ThunderboltUIMessage } from '@/types'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { SeedTurn, WorkspaceFile } from '@shared/agent-core'

export type BuiltInConversationDeps = {
  readonly getAttachment: typeof getAttachment
  readonly getTransformer: typeof getTransformer
  readonly blobToBase64: typeof blobToBase64
  readonly readXlsxSheets: typeof readXlsxSheets
}

const defaultDeps: BuiltInConversationDeps = { getAttachment, getTransformer, blobToBase64, readXlsxSheets }

export type BuiltInConversationOptions = {
  /** True when the turn's tools are active, so the model can query attachments
   *  written to its workspace. False keeps attachments fully inline. */
  readonly workspace: boolean
}

export type BuiltInPrompt = {
  readonly text: string
  readonly images: ImageContent[]
}

export type PreparedBuiltInConversation = {
  readonly history: SeedTurn[]
  readonly prompt: BuiltInPrompt
  /** Attachment files to write into the thread workspace before the run. */
  readonly files: WorkspaceFile[]
}

type PreparedPart = {
  readonly text: string
  readonly images: ImageContent[]
  readonly files: WorkspaceFile[]
}

type AttachmentData = Extract<ThunderboltUIMessage['parts'][number], { type: 'data-attachment' }>['data']

/** Inline preview budget for an attachment written to the workspace. Short files fit whole. */
const previewMaxLines = 200
const previewMaxChars = 16_000

/** Label attachment content in plain-text conversation history. */
const attachmentText = (filename: string, text?: string): string =>
  text ? `[Attachment: ${filename}]\n\n${text}` : `[Attachment: ${filename}]`

/** Convert transformer data URL to Pi's raw-base64 image shape. */
const imageFromDataUrl = (mimeType: string, dataUrl: string): ImageContent => ({
  type: 'image',
  mimeType,
  data: dataUrl.slice(dataUrl.indexOf(',') + 1),
})

/** Reduce a file or sheet name to one safe path segment inside the workspace:
 *  each run of separators and other unsafe characters becomes a single `_`. */
const safeSegment = (name: string): string => {
  const segment = name.replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim()
  return segment === '' || segment === '.' || segment === '..' ? 'file' : segment
}

/** Head of `text` within the preview budget, plus a marker when it isn't whole. */
const previewText = (text: string): string => {
  const lines = text.replace(/\n$/, '').split('\n')
  const budget = { lines: 0, chars: 0 }
  for (const line of lines) {
    // Count the newline joining this line to the previous one, not one after the last.
    const cost = line.length + (budget.lines > 0 ? 1 : 0)
    if (budget.lines === previewMaxLines || budget.chars + cost > previewMaxChars) {
      break
    }
    budget.lines++
    budget.chars += cost
  }
  if (budget.lines === lines.length) {
    return lines.join('\n')
  }
  const hint =
    'Compute over the full file with bash instead of answering from this preview. If the full file cannot be read, say so rather than answering from the preview.'
  if (budget.lines === 0) {
    return `${text.slice(0, previewMaxChars)}\n\n[Showing the first ${previewMaxChars} of ${text.length} characters. ${hint}]`
  }
  return `${lines.slice(0, budget.lines).join('\n')}\n\n[Showing lines 1-${budget.lines} of ${lines.length}. ${hint}]`
}

/** Label a workspace-backed attachment: where its files live, then its preview. */
const workspaceAttachment = (filename: string, files: WorkspaceFile[], preview: string): PreparedPart => ({
  text: `[Attachment: ${filename} — saved as ${files.map((file) => file.path).join(', ')}]\n\n${previewText(preview)}`,
  images: [],
  files,
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

/** `name`, or `name (2)`, `name (3)`… when an earlier sheet already took it. */
const freeName = (name: string, used: ReadonlySet<string>, n = 1): string => {
  const candidate = n === 1 ? name : `${name} (${n})`
  return used.has(candidate) ? freeName(name, used, n + 1) : candidate
}

/** Write each sheet as its own TSV, parsing the workbook once for both files and preview. */
const xlsxAttachment = async (
  filename: string,
  dir: string,
  file: StoredFile,
  deps: BuiltInConversationDeps,
): Promise<PreparedPart> => {
  const sheets = await deps.readXlsxSheets(file)
  const used = new Set<string>()
  const files = sheets.map((sheet) => {
    const name = freeName(safeSegment(sheet.name), used)
    used.add(name)
    return { path: `${dir}/${name}.tsv`, content: toTsv(sheet.rows) }
  })
  const preview = sheets.map((sheet, index) => `## Sheet: ${sheet.name}\n${files[index].content}`).join('')
  return workspaceAttachment(filename, files, preview)
}

/**
 * Represent an attachment's text for the model, or null when it has none.
 * Without a workspace it is inlined whole. With one, its full content is written
 * to the workspace (CSV and spreadsheet sheets as TSV when they convert cleanly)
 * and the prompt carries its path plus a bounded preview.
 */
const textAttachment = async (
  data: AttachmentData,
  file: StoredFile,
  options: BuiltInConversationOptions,
  deps: BuiltInConversationDeps,
): Promise<PreparedPart | null> => {
  const { filename, localFileId, mimeType } = data
  const dir = `attachments/${safeSegment(localFileId)}`
  if (options.workspace && mimeType === xlsxMime) {
    return xlsxAttachment(filename, dir, file, deps)
  }
  const text = await extractAttachmentText(file, mimeType, deps)
  if (text === null) {
    return null
  }
  if (!options.workspace || text === '') {
    return { text: attachmentText(filename, text), images: [], files: [] }
  }
  const name = safeSegment(filename)
  const tsv = mimeType === 'text/csv' || /\.csv$/i.test(filename) ? csvToTsv(text) : null
  if (tsv !== null) {
    return workspaceAttachment(filename, [{ path: `${dir}/${name.replace(/\.csv$/i, '')}.tsv`, content: tsv }], tsv)
  }
  const path = isPlainTextMime(mimeType) ? `${dir}/${name}` : `${dir}/${name}.txt`
  return workspaceAttachment(filename, [{ path, content: text }], text)
}

/** Map one attachment reference to Pi-supported prompt text, image blocks, and workspace files. */
const prepareAttachment = async (
  part: Extract<ThunderboltUIMessage['parts'][number], { type: 'data-attachment' }>,
  isCurrentTurn: boolean,
  options: BuiltInConversationOptions,
  deps: BuiltInConversationDeps,
): Promise<PreparedPart> => {
  const { filename, localFileId, mimeType, deliverAs } = part.data
  const file = await deps.getAttachment(localFileId)
  if (!file) {
    return { text: `${attachmentText(filename)} (file unavailable on this device)`, images: [], files: [] }
  }

  if (!isCurrentTurn) {
    return (
      (await textAttachment(part.data, file, options, deps)) ?? {
        text: attachmentText(filename),
        images: [],
        files: [],
      }
    )
  }

  const mode = deliverAs ?? defaultDeliveryMode(mimeType)
  if (mode === 'images') {
    const transformer = await deps.getTransformer(mimeType, 'images')
    const output = transformer ? await transformer(file) : null
    if (output && 'images' in output) {
      return {
        text: attachmentText(filename),
        images: output.images.map((image) => imageFromDataUrl(image.mimeType, image.dataUrl)),
        files: [],
      }
    }
  }

  if (mode === 'text') {
    const prepared = await textAttachment(part.data, file, options, deps)
    if (prepared) {
      return prepared
    }
  }

  if (mimeType.startsWith('image/')) {
    return {
      text: attachmentText(filename),
      images: [{ type: 'image', mimeType, data: await deps.blobToBase64(file.blob) }],
      files: [],
    }
  }

  // Pi has no native document/file content block. Prefer local text extraction
  // for PDF/docx even when legacy delivery would send raw bytes.
  const prepared = mode === 'text' ? null : await textAttachment(part.data, file, options, deps)
  if (prepared) {
    return prepared
  }
  return { text: `${attachmentText(filename)} (file type unsupported by built-in agent)`, images: [], files: [] }
}

/** Convert one UI message to Pi-compatible text/images while preserving part order. */
const prepareMessage = async (
  message: ThunderboltUIMessage,
  isCurrentTurn: boolean,
  options: BuiltInConversationOptions,
  deps: BuiltInConversationDeps,
): Promise<PreparedPart> => {
  const hydrated = hydrateQuotesAsText([message])[0]
  const parts = await Promise.all(
    hydrated.parts.map(async (part): Promise<PreparedPart> => {
      if (part.type === 'text') {
        return { text: part.text, images: [], files: [] }
      }
      if (isAttachmentPart(part)) {
        return prepareAttachment(part, isCurrentTurn, options, deps)
      }
      return { text: '', images: [], files: [] }
    }),
  )
  return {
    text: parts
      .map((part) => part.text)
      .filter(Boolean)
      .join('\n'),
    images: parts.flatMap((part) => part.images),
    files: parts.flatMap((part) => part.files),
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

/** Prepare prior text history, latest Pi-native prompt content, and the attachment files to write. */
export const prepareBuiltInConversation = async (
  messages: ThunderboltUIMessage[],
  skillInstructions: string[] | undefined,
  options: BuiltInConversationOptions,
  deps: BuiltInConversationDeps = defaultDeps,
): Promise<PreparedBuiltInConversation> => {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  if (lastUserIndex === -1) {
    throw new Error('Built-in adapter: no user message in request body')
  }

  const priorMessages = await Promise.all(
    messages.slice(0, lastUserIndex).map(async (message) => {
      if (message.role !== 'user' && message.role !== 'assistant') {
        return null
      }
      return { role: message.role, prepared: await prepareMessage(message, false, options, deps) }
    }),
  )
  const prior = priorMessages.filter((entry) => entry !== null)
  const current = await prepareMessage(messages[lastUserIndex], true, options, deps)
  const turns = coalesceTurns([
    ...prior
      .filter(({ prepared }) => prepared.text.length > 0)
      .map(({ role, prepared }): SeedTurn => ({ role, text: prepared.text })),
    { role: 'user', text: current.text },
  ])
  const promptTurn = turns.at(-1)
  if (!promptTurn) {
    throw new Error('Built-in adapter: current user message has no supported content')
  }
  const skillPrefix = skillInstructions?.length ? `${skillInstructions.join('\n\n')}\n\n` : ''
  const files = [...prior.map(({ prepared }) => prepared), current].flatMap((prepared) => prepared.files)
  return {
    history: turns.slice(0, -1),
    prompt: { text: `${skillPrefix}${promptTurn.text}`, images: current.images },
    files: [...new Map(files.map((file) => [file.path, file])).values()],
  }
}
