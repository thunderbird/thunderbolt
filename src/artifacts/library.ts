/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'
import { isRenderHtmlPart, renderHtmlInput, renderHtmlOutput } from './render-html-tool'
import { uuidv7ToDate } from '@/lib/utils'

export type MessageArtifactRow = { id: string; chatThreadId: string | null; parts: unknown; chatTitle: string | null }
export type MessageArtifact = {
  id: string
  messageId: string
  chatThreadId: string
  chatTitle: string | null
  title: string | null
  html: string
  createdAt: Date
}

/** Message JSON can arrive parsed or serialized from the local database driver. */
const parseParts = (parts: unknown): UIMessage['parts'] => {
  if (Array.isArray(parts)) {
    return parts as UIMessage['parts']
  }
  if (typeof parts !== 'string') {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(parts)
    return Array.isArray(parsed) ? (parsed as UIMessage['parts']) : []
  } catch {
    return []
  }
}

/** Index completed, verified HTML artifacts from every chat execution environment. */
export const messageArtifacts = (rows: readonly MessageArtifactRow[]): MessageArtifact[] =>
  rows
    .flatMap((row) => {
      if (!row.chatThreadId) {
        return []
      }
      return parseParts(row.parts)
        .filter(isRenderHtmlPart)
        .flatMap((part, index) => {
          const input = renderHtmlInput(part)
          if (part.state !== 'output-available' || renderHtmlOutput(part)?.ok !== true || !input.html?.trim()) {
            return []
          }
          return [
            {
              id: `${row.id}-${index}`,
              messageId: row.id,
              chatThreadId: row.chatThreadId!,
              chatTitle: row.chatTitle,
              title: input.title?.trim() || null,
              html: input.html,
              createdAt: uuidv7ToDate(row.id),
            },
          ]
        })
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

export type ArtifactSelection = { kind: 'snapshot' | 'message'; id: string }

/** Keep each persisted artifact identity addressable independently of an agent route. */
export const artifactLocation = (selection?: ArtifactSelection | null): string => {
  if (!selection) {
    return '/artifacts'
  }
  return `/artifacts?${selection.kind === 'snapshot' ? 'artifact' : 'local'}=${encodeURIComponent(selection.id)}`
}

/** Read both independent snapshot and existing chat-artifact deep links. */
export const artifactSelection = (search: URLSearchParams): ArtifactSelection | null => {
  const snapshotId = search.get('artifact')
  if (snapshotId) {
    return { kind: 'snapshot', id: snapshotId }
  }
  const messageId = search.get('local')
  return messageId ? { kind: 'message', id: messageId } : null
}
