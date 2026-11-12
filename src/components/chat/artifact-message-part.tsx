/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { PageDefinition } from '@shared/page-protocol'
import { renderHtmlInput, renderHtmlOutput, type RenderHtmlPart } from '@/artifacts/render-html-tool'
import { useChatStore } from '@/chats/chat-store'
import { useThrottle } from '@/hooks/use-throttle'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { artifactPageId } from '@/pages/artifact-page-id'
import { pageController } from '@/pages/page-controller'
import { usePageStore } from '@/pages/page-store'
import { usePagePublication } from '@/pages/page-publications-context'
import { InlineArtifactCard } from './inline-artifact-card'

/** How often the live streaming preview refreshes, so rapid token updates don't thrash the iframe. */
const artifactPreviewThrottleMs = 120

type ArtifactMessagePartProps = {
  part: ToolOrDynamicToolUIPart
}

/** Only inline artifacts render in chat; sidebar publication is owned by the tool and page controller. */
export const ArtifactMessagePart = ({ part }: ArtifactMessagePartProps) => {
  const { t } = useLingui()
  const artifactId = part.toolCallId
  const input = renderHtmlInput(part as RenderHtmlPart)
  const output = renderHtmlOutput(part as RenderHtmlPart)
  const published = output?.ok ? output : undefined
  const title = input.title?.trim() || t`Artifact`
  const streaming = part.state === 'input-streaming' || part.state === 'input-available'
  const verified = part.state === 'output-available' && !!published
  const throttledHtml = useThrottle(input.html ?? '', artifactPreviewThrottleMs)
  const html = streaming ? throttledHtml : (input.html ?? '')
  const pageId = published?.pageId ?? input.pageId ?? artifactPageId(artifactId)
  const latest = usePagePublication(pageId)
  const chatThreadId = useChatStore((state) => state.currentSessionId)
  const page = useMemo<PageDefinition>(() => {
    const source = latest?.page.source
    return latest && source?.kind === 'html'
      ? {
          ...latest.page,
          source: { ...source, artifact: { toolCallId: artifactId, ...source.artifact, chatThreadId } },
        }
      : { id: pageId, title, source: { kind: 'html', html, artifact: { toolCallId: artifactId, chatThreadId } } }
  }, [latest, pageId, artifactId, title, html, chatThreadId])
  const session = usePageStore((state) => state.sessions.find((session) => session.page.id === page.id))
  // The original card follows updates, but mounting an old result must never overwrite a live document.
  const currentPage = session?.page ?? page
  const currentTitle = currentPage.title.trim() || title
  const currentHtml = currentPage.source.kind === 'html' ? currentPage.source.html : html
  const open = () => {
    usePageStore.getState().ensure(currentPage, { chatThreadId })
    pageController.open(currentPage)
  }

  if (streaming) {
    return input.presentation === 'inline' && !input.pageId ? (
      <InlineArtifactCard html={html} title={title} streaming />
    ) : null
  }
  if (!verified || (latest && latest.firstToolCallId !== artifactId)) {
    return null
  }
  // Older saved HTML results have no hint and retain their original inline presentation.
  const placement = session?.presentation ?? latest?.presentation ?? published?.presentation ?? 'inline'
  if (placement !== 'inline') {
    return null
  }
  return <InlineArtifactCard html={currentHtml} title={currentTitle} page={currentPage} onOpenInPanel={open} />
}
