/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'
import { isRenderHtmlPart, renderHtmlInput } from '@/artifacts/render-html-tool'
import { artifactId, toHtmlArtifact, type Artifact } from '@/artifacts/artifact'
import { uuidv7ToDate } from '@/lib/utils'

export type ProjectArtifact = {
  id: string
  messageId: string
  toolCallId: string
  chatThreadId: string
  chatTitle: string
  title: string
  html: string
  createdAt: Date
}

export type ArtifactMessageRow = {
  id: string
  chatThreadId: string | null
  parts: unknown
  chatTitle: string | null
}

/** The driver returns either JSON text or parsed parts; older/corrupt rows are not artifacts. */
const parseParts = (parts: unknown): UIMessage['parts'] => {
  if (typeof parts === 'string') {
    try {
      return parseParts(JSON.parse(parts))
    } catch {
      return []
    }
  }
  if (!Array.isArray(parts)) {
    return []
  }
  return parts.filter((part) => part && typeof part === 'object' && typeof part.type === 'string')
}

/** Collect verified outputs, using the shared source identity and verification gate. */
export const collectProjectArtifacts = (
  rows: readonly ArtifactMessageRow[],
  labels: { untitledChat: string; untitledArtifact: string },
): ProjectArtifact[] =>
  rows
    .flatMap((row) => {
      if (!row.chatThreadId) {
        return []
      }
      const chatThreadId = row.chatThreadId
      return parseParts(row.parts)
        .filter(isRenderHtmlPart)
        .flatMap((part) => {
          const input = renderHtmlInput(part)
          const source = toHtmlArtifact(row.id, chatThreadId, part)
          if (!source || source.source.kind !== 'html') {
            return []
          }
          return [
            {
              id: source.id,
              messageId: row.id,
              toolCallId: part.toolCallId,
              chatThreadId,
              chatTitle: row.chatTitle?.trim() || labels.untitledChat,
              title: input.title?.trim() || labels.untitledArtifact,
              html: source.source.html,
              createdAt: uuidv7ToDate(row.id),
            },
          ]
        })
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

/** Read the synced pin list, ignoring removed artifacts and duplicate/stale references. */
export const readArtifactPins = (value: string | null, artifacts: readonly Pick<ProjectArtifact, 'id'>[]): string[] => {
  if (!value) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      throw new Error('Saved artifact pins must be an array')
    }
    const liveIds = new Set(artifacts.map((artifact) => artifact.id))
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && liveIds.has(id)))]
  } catch (error) {
    console.error('[projects] Could not read saved artifact pins', error)
    return []
  }
}

/** Adapt project metadata to the shared rendering and runtime boundary. */
export const toProjectArtifactSource = (artifact: ProjectArtifact): Artifact => {
  const reference = { kind: 'html' as const, messageId: artifact.messageId, toolCallId: artifact.toolCallId }
  return {
    id: artifactId(reference),
    reference,
    title: artifact.title,
    chatThreadId: artifact.chatThreadId,
    source: { kind: 'html', html: artifact.html },
  }
}
