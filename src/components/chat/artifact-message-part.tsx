/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHtmlInput, renderHtmlOutput, type RenderHtmlPart } from '@/artifacts/render-html-tool'
import { Button } from '@/components/ui/button'
import { useContentView } from '@/content-view/context'
import { useThrottle } from '@/hooks/use-throttle'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { PanelRight } from 'lucide-react'
import { InlineArtifactCard } from './inline-artifact-card'

/** How often the live streaming preview refreshes, so rapid token updates don't thrash the iframe. */
const artifactPreviewThrottleMs = 120

type ArtifactMessagePartProps = {
  part: ToolOrDynamicToolUIPart
}

/**
 * Renders a `render_html` tool call as a first-class artifact in the transcript.
 * From the moment the call starts it shows an inline card that streams into place
 * (scripts off) and then becomes the interactive artifact once verified. It lives
 * in exactly one place at a time: inline, OR the side panel — while it's open in
 * the panel the transcript shows a slim placeholder instead. A finished-but-failed
 * call renders nothing here (it stays an ordinary tool call in the group).
 */
export const ArtifactMessagePart = ({ part }: ArtifactMessagePartProps) => {
  const artifactId = part.toolCallId
  const input = renderHtmlInput(part as RenderHtmlPart)
  const title = input.title?.trim() || 'Artifact'

  const streaming = part.state === 'input-streaming' || part.state === 'input-available'
  const verified = part.state === 'output-available' && renderHtmlOutput(part as RenderHtmlPart)?.ok === true

  // Throttle the streaming HTML into the preview iframe; render the exact HTML once verified.
  const throttledHtml = useThrottle(input.html ?? '', artifactPreviewThrottleMs)
  const html = streaming ? throttledHtml : (input.html ?? '')

  const { state, showArtifact, close } = useContentView()
  const shownInPanel = state.type === 'artifact' && state.data.artifactId === artifactId

  // Live inline card from the moment the call starts (even before any HTML arrives).
  if (streaming) {
    return <InlineArtifactCard html={html} title={title} streaming />
  }
  // Finished but not verified — it stays an ordinary tool call in the group.
  if (!verified) {
    return null
  }
  // Verified: exactly one of inline or the side panel — never both.
  if (shownInPanel) {
    return <ArtifactPanelBar title={title} onShowInline={close} />
  }
  return (
    <InlineArtifactCard html={html} title={title} onOpenInPanel={() => showArtifact({ html, title, artifactId })} />
  )
}

type ArtifactPanelBarProps = {
  title: string
  onShowInline: () => void
}

/** Slim placeholder shown in the transcript while the artifact is open in the side panel. */
const ArtifactPanelBar = ({ title, onShowInline }: ArtifactPanelBarProps) => (
  <div className="my-2 flex items-center gap-2 rounded-xl border border-dashed border-border bg-card/50 px-3 py-2">
    <PanelRight className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{title} — shown in side panel</span>
    <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={onShowInline}>
      Show inline
    </Button>
  </div>
)
