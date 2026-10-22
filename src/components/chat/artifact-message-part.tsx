/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHtmlInput, type RenderHtmlPart } from '@/artifacts/render-html-tool'
import { toHtmlArtifact } from '@/artifacts/artifact'
import { Button } from '@/components/ui/button'
import { useContentView } from '@/content-view/context'
import { useThrottle } from '@/hooks/use-throttle'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { Trans, useLingui } from '@lingui/react/macro'
import { Maximize2, PanelRight } from 'lucide-react'
import { useNavigate, useParams } from 'react-router'
import { InlineArtifactCard } from './inline-artifact-card'
import { useContext } from 'react'
import { ArtifactCanvasContext } from '@/artifacts/artifact-canvas-context'

/** How often the live streaming preview refreshes, so rapid token updates don't thrash the iframe. */
const artifactPreviewThrottleMs = 120

type ArtifactMessagePartProps = {
  part: ToolOrDynamicToolUIPart
  messageId: string
  chatThreadId: string | null
}

/**
 * Renders a `render_html` tool call as a first-class artifact in the transcript.
 * From the moment the call starts it shows an inline card that streams into place
 * (scripts off) and then becomes the interactive artifact once verified. It lives
 * in exactly one place at a time: inline, OR the side panel — while it's open in
 * the panel the transcript shows a slim placeholder instead. A finished-but-failed
 * call renders nothing here (it stays an ordinary tool call in the group).
 */
export const ArtifactMessagePart = ({ part, messageId, chatThreadId }: ArtifactMessagePartProps) => {
  const { t } = useLingui()
  const canvas = useContext(ArtifactCanvasContext)
  const { artifactId: routeArtifactId } = useParams()
  const navigate = useNavigate()
  const input = renderHtmlInput(part as RenderHtmlPart)
  const title = input.title?.trim() || t`Artifact`

  const streaming = part.state === 'input-streaming' || part.state === 'input-available'
  const artifact = toHtmlArtifact(messageId, chatThreadId, part)

  // Throttle the streaming HTML into the preview iframe; render the exact HTML once verified.
  const throttledHtml = useThrottle(input.html ?? '', artifactPreviewThrottleMs)
  const html = streaming ? throttledHtml : (input.html ?? '')

  const { state, close } = useContentView()
  const shownInPanel = state.type === 'artifact' && state.data.id === artifact?.id

  // Live inline card from the moment the call starts (even before any HTML arrives).
  if (streaming) {
    return <InlineArtifactCard html={html} title={title} streaming />
  }
  // Finished but not verified — it stays an ordinary tool call in the group.
  if (!artifact) {
    return null
  }
  if (canvas?.messageId === messageId && canvas.toolCallId === part.toolCallId) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-xl border border-border bg-card/50 px-3 py-2">
        <PanelRight className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        <Button variant="ghost" size="sm" onClick={canvas.reveal}>
          <Trans>Show artifact</Trans>
        </Button>
      </div>
    )
  }
  // Verified: exactly one of inline or the side panel — never both.
  if (shownInPanel) {
    return <ArtifactLocationBar title={title} display="sidebar" onShowInline={close} />
  }
  if (routeArtifactId === artifact.id) {
    return (
      <ArtifactLocationBar
        title={title}
        display="workspace"
        onShowInline={() => {
          close()
          void navigate(
            chatThreadId
              ? `/chats/${encodeURIComponent(chatThreadId)}?view=chat`
              : `/artifacts?inline=${encodeURIComponent(artifact.id)}`,
          )
        }}
      />
    )
  }
  return <InlineArtifactCard html={html} title={title} artifact={artifact} />
}

type ArtifactLocationBarProps = {
  title: string
  display: 'sidebar' | 'workspace'
  onShowInline: () => void
}

/** The transcript keeps a location control instead of mounting a duplicate executable frame. */
const ArtifactLocationBar = ({ title, display, onShowInline }: ArtifactLocationBarProps) => (
  <div className="my-2 flex items-center gap-2 rounded-xl border border-dashed border-border bg-card/50 px-3 py-2">
    {display === 'sidebar' ? (
      <PanelRight className="size-4 shrink-0 text-muted-foreground" />
    ) : (
      <Maximize2 className="size-4 shrink-0 text-muted-foreground" />
    )}
    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
      {display === 'sidebar' ? (
        <Trans>{title} — shown in side panel</Trans>
      ) : (
        <Trans>{title} — open beside this chat</Trans>
      )}
    </span>
    <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={onShowInline}>
      <Trans>Show inline</Trans>
    </Button>
  </div>
)
