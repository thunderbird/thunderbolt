/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PageDefinition } from '@shared/page-protocol'
import { isToolOrDynamicToolUIPart } from 'ai'
import { isRenderHtmlPart, renderHtmlInput, renderHtmlOutput } from '@/artifacts/render-html-tool'
import type { ThunderboltUIMessage } from '@/types'
import { artifactPageId } from './artifact-page-id'
import { publishedPageOutput, type PublishedPageOutput } from './published-page-output'

export type PagePublication = {
  page: PageDefinition
  presentation?: 'inline' | 'sidebar'
  firstToolCallId: string
}

/** Read a successful publication from either HTML generation or another page tool. */
export const pagePublicationFromPart = (part: ThunderboltUIMessage['parts'][number]): PublishedPageOutput | null => {
  if (!isRenderHtmlPart(part) || part.state !== 'output-available') {
    return publishedPageOutput(part)
  }
  const output = renderHtmlOutput(part)
  if (!output?.ok) {
    return null
  }
  const input = renderHtmlInput(part)
  return {
    page: {
      id: output.pageId ?? input.pageId ?? artifactPageId(part.toolCallId),
      title: input.title ?? '',
      source: { kind: 'html', html: input.html ?? '', artifact: { toolCallId: part.toolCallId } },
    },
    presentation: output.presentation,
  }
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
      const published = pagePublicationFromPart(part)
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
