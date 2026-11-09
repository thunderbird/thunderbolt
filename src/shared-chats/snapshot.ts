/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHtmlToolName } from '@/artifacts/constants'
import { isRenderHtmlPart, renderHtmlInput, renderHtmlOutput } from '@/artifacts/render-html-tool'
import { isAttachmentPart } from '@/lib/attachments'
import type { ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import { askCachePrefix } from '@/widgets/ask/lib'
import type { UIMessage } from 'ai'
import { z } from 'zod'

/** Wire version of the snapshot JSON inside a share. */
export const shareSnapshotVersion = 1

/** A file the sharer attached: its name and type only — the bytes never left their device. */
export type SnapshotAttachmentPart = { type: 'data-attachment'; data: { filename: string; mimeType: string } }

/** A verified `render_html` artifact, normalised to the one shape the viewer renders. */
export type SnapshotArtifactPart = {
  type: `tool-${typeof renderHtmlToolName}`
  toolCallId: string
  state: 'output-available'
  input: { html: string; title?: string }
  output: { ok: true }
}

export type SnapshotTextPart = { type: 'text'; text: string }

export type SnapshotPart = SnapshotTextPart | SnapshotArtifactPart | SnapshotAttachmentPart

/** The citation metadata a reply's text needs to render its sources. */
export type SnapshotMetadata = Pick<UIMessageMetadata, 'sources' | 'haystackReferences' | 'haystackDocuments'>

export type SnapshotMessage = {
  id: string
  role: 'user' | 'assistant'
  parts: SnapshotPart[]
  /** Widget data (weather, link previews, ask answers) as the sharer's message stored it. */
  cache?: Record<string, unknown>
  metadata?: SnapshotMetadata
}

/**
 * A frozen copy of a chat: what the user wrote and what the model answered,
 * nothing behind it. Reasoning, every tool call but artifacts, MCP data, model
 * ids, usage and internal ids never enter it.
 */
export type ShareSnapshot = {
  version: typeof shareSnapshotVersion
  title: string
  messages: SnapshotMessage[]
}

/** The stored columns a snapshot reads from one message — a `ChatMessage` row satisfies it. */
export type SnapshotSource = {
  id: string
  role: string | null
  parts: UIMessage['parts'] | null
  cache: Record<string, unknown> | null
  metadata: UIMessageMetadata | null
}

/** Keep one part if the snapshot allows it, in its normalised shape. */
const toSnapshotPart = (part: UIMessage['parts'][number]): SnapshotPart | null => {
  if (part.type === 'text') {
    return part.text.trim() ? { type: 'text', text: part.text } : null
  }
  if (isAttachmentPart(part)) {
    return { type: 'data-attachment', data: { filename: part.data.filename, mimeType: part.data.mimeType } }
  }
  if (isRenderHtmlPart(part) && part.state === 'output-available' && renderHtmlOutput(part)?.ok === true) {
    const { html, title } = renderHtmlInput(part)
    if (!html) {
      return null
    }
    return {
      type: `tool-${renderHtmlToolName}`,
      toolCallId: part.toolCallId,
      state: 'output-available',
      input: { html, ...(title ? { title } : {}) },
      output: { ok: true },
    }
  }
  return null
}

const pickCitationMetadata = (metadata: UIMessageMetadata | null | undefined): SnapshotMetadata | undefined => {
  if (!metadata) {
    return undefined
  }
  const { sources, haystackReferences, haystackDocuments } = metadata
  const picked = { sources, haystackReferences, haystackDocuments }
  return Object.values(picked).some((value) => value !== undefined) ? picked : undefined
}

/**
 * The widget cache entries a shared chat renders from, by key prefix. Others —
 * such as a connect-integration widget's hidden state — stay with the sharer.
 */
const sharedCacheNamespaces = ['linkPreview', 'weatherForecast', askCachePrefix]

const pickSharedCache = (cache: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined => {
  const entries = Object.entries(cache ?? {}).filter(([key]) =>
    sharedCacheNamespaces.some((namespace) => key.startsWith(`${namespace}/`)),
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * Build a share snapshot from a chat's stored rows. An allowlist, not a filter:
 * anything not named here stays out, so a new part type or metadata field is
 * private until someone decides to share it.
 */
export const buildShareSnapshot = (title: string, messages: SnapshotSource[]): ShareSnapshot => ({
  version: shareSnapshotVersion,
  title,
  messages: messages.flatMap((message): SnapshotMessage[] => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return []
    }
    const parts = (message.parts ?? []).map(toSnapshotPart).filter((part) => part !== null)
    if (parts.length === 0) {
      return []
    }
    const cache = pickSharedCache(message.cache)
    const metadata = pickCitationMetadata(message.metadata)
    return [
      { id: message.id, role: message.role, parts, ...(cache ? { cache } : {}), ...(metadata ? { metadata } : {}) },
    ]
  }),
})

/** The part shapes a snapshot may carry; anything else is dropped on the way in. */
const snapshotPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('data-attachment'),
    data: z.object({ filename: z.string(), mimeType: z.string() }),
  }),
  z.object({
    type: z.literal(`tool-${renderHtmlToolName}`),
    toolCallId: z.string(),
    state: z.literal('output-available'),
    input: z.object({ html: z.string(), title: z.string().optional() }),
    output: z.object({ ok: z.literal(true) }),
  }),
])

const sourceSchema = z.object({
  index: z.number(),
  url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  image: z.string().nullable().optional(),
  favicon: z.string().nullable().optional(),
  siteName: z.string().optional(),
  author: z.string().nullable().optional(),
  publishedDate: z.string().nullable().optional(),
  toolName: z.enum(['search', 'fetch_content']),
})

const haystackReferenceSchema = z.object({
  position: z.number(),
  fileId: z.string(),
  fileName: z.string(),
  pageNumber: z.number().optional(),
})

const haystackDocumentSchema = z.object({
  id: z.string(),
  content: z.string(),
  score: z.number(),
  file: z.object({ id: z.string(), name: z.string() }),
})

const snapshotSchema = z.object({
  version: z.literal(shareSnapshotVersion),
  title: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      role: z.enum(['user', 'assistant']),
      parts: z.array(z.unknown()),
      // Values stay opaque: one odd entry must not make the whole share unreadable.
      cache: z.record(z.string(), z.unknown()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
})

/** The value of a citation field when it has the shape the renderer expects, else nothing. */
const validField = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Citation metadata from another account, each field kept only when well formed. */
const parseCitationMetadata = (metadata: Record<string, unknown> | undefined): UIMessageMetadata | null =>
  metadata
    ? {
        sources: validField(z.array(sourceSchema), metadata.sources),
        haystackReferences: validField(z.array(haystackReferenceSchema), metadata.haystackReferences),
        haystackDocuments: validField(z.array(haystackDocumentSchema), metadata.haystackDocuments),
      }
    : null

/**
 * Parse a decrypted snapshot. It was written by another account, so every part
 * and citation field is checked against the shape the viewer renders, and
 * anything malformed is dropped rather than handed to a component that would
 * crash on it. What survives goes back through the same allowlist, so a
 * sharer's client that slipped in other parts or metadata does not get them
 * rendered. Widget cache values stay opaque here; a widget that crashes on
 * one is contained by the transcript's per-message error boundary.
 */
export const parseShareSnapshot = (value: unknown): ShareSnapshot => {
  const parsed = snapshotSchema.parse(value)
  return buildShareSnapshot(
    parsed.title,
    parsed.messages.map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts.flatMap((part) => {
        const valid = snapshotPartSchema.safeParse(part)
        return valid.success ? [valid.data as UIMessage['parts'][number]] : []
      }),
      cache: message.cache ?? null,
      metadata: parseCitationMetadata(message.metadata),
    })),
  )
}

/** A snapshot message as the transcript components render it. */
export const toUIMessage = (message: SnapshotMessage): ThunderboltUIMessage =>
  ({
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata ?? {},
  }) as ThunderboltUIMessage
