/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PageDefinition } from '@shared/page-protocol'
import { getToolName, isToolOrDynamicToolUIPart } from 'ai'
import { renderHtmlInput, renderHtmlOutput } from '@/artifacts/render-html-tool'
import { renderHtmlToolName } from '@/artifacts/constants'
import type { ThunderboltUIMessage } from '@/types'
import { artifactPageId } from './artifact-page-id'
import { publishedPageOutput } from './published-page-output'

export type PagePublication = {
  page: PageDefinition
  presentation?: 'inline' | 'sidebar'
  firstToolCallId: string
}

/** Index explicit page identities so every transcript entry reopens the latest successful snapshot. */
export const indexPagePublications = (
  messages: readonly Pick<ThunderboltUIMessage, 'id' | 'role' | 'parts'>[],
): ReadonlyMap<string, PagePublication> => {
  const publications = new Map<string, PagePublication>()
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }
    for (const part of message.parts) {
      if (!isToolOrDynamicToolUIPart(part) || part.state !== 'output-available') {
        continue
      }
      if (getToolName(part) === renderHtmlToolName) {
        const output = renderHtmlOutput(part)
        if (!output?.ok) {
          continue
        }
        const input = renderHtmlInput(part)
        const id = output.pageId ?? input.pageId ?? artifactPageId(part.toolCallId)
        publications.set(id, {
          page: {
            id,
            title: input.title ?? '',
            source: {
              kind: 'html',
              html: input.html ?? '',
              artifact: { toolCallId: part.toolCallId, messageId: message.id },
            },
          },
          presentation: output.presentation,
          firstToolCallId: publications.get(id)?.firstToolCallId ?? part.toolCallId,
        })
        continue
      }
      const published = publishedPageOutput(part)
      if (published) {
        const source = published.page.source
        publications.set(published.page.id, {
          page: {
            ...published.page,
            source:
              source.kind === 'html'
                ? { ...source, artifact: { toolCallId: part.toolCallId, messageId: message.id } }
                : source,
          },
          presentation: published.presentation,
          firstToolCallId: publications.get(published.page.id)?.firstToolCallId ?? part.toolCallId,
        })
      }
    }
  }
  return publications
}
