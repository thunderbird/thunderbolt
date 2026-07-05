/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useArtifactTarget } from '@/artifacts/artifact-target-store'
import type { ArtifactTarget, RenderHtmlInput, RenderHtmlOutput } from '@/artifacts/render-html-tool'
import { Button } from '@/components/ui/button'
import { useShowArtifact } from '@/content-view/context'
import { useThrottledValue } from '@/hooks/use-throttled-value'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { AppWindow, Minimize2 } from 'lucide-react'
import { InlineArtifactCard } from './inline-artifact-card'

/** How often the live streaming preview refreshes, so rapid token updates don't thrash the iframe. */
const artifactPreviewThrottleMs = 120

type ArtifactMessagePartProps = {
  part: ToolOrDynamicToolUIPart
}

/**
 * Renders a `render_html` tool call as a first-class artifact in the transcript.
 * While its HTML streams in, it shows a live inline preview (scripts off) so you
 * can watch it come together; once verified it becomes the real interactive
 * artifact — inline, or a compact chip if moved to the side panel. A failed or
 * not-yet-started call renders nothing here (it stays an ordinary tool call in
 * the reasoning group).
 */
export const ArtifactMessagePart = ({ part }: ArtifactMessagePartProps) => {
  const artifactId = part.toolCallId
  const input = (part.input ?? {}) as Partial<RenderHtmlInput>
  const title = input.title?.trim() || 'Artifact'

  const streaming = part.state === 'input-streaming' || part.state === 'input-available'
  const output = part.state === 'output-available' ? (part.output as RenderHtmlOutput | undefined) : undefined
  const verified = output?.ok === true

  // Throttle the streaming HTML into the preview iframe; render the exact HTML once verified.
  const throttledHtml = useThrottledValue(input.html ?? '', artifactPreviewThrottleMs)
  const html = streaming ? throttledHtml : (input.html ?? '')

  const fallbackTarget: ArtifactTarget = verified && output ? output.target : 'inline'
  const { target, setTarget } = useArtifactTarget(artifactId, fallbackTarget)
  const showArtifact = useShowArtifact()

  // Nothing to render until there's HTML, and nothing here for a finished-but-failed call.
  if (!html || (part.state === 'output-available' && !verified) || part.state === 'output-error') {
    return null
  }

  const openInPanel = showArtifact
    ? () => {
        setTarget('panel')
        showArtifact({ html, title, artifactId })
      }
    : undefined

  if (verified && target === 'panel') {
    return <PanelArtifactChip title={title} onOpen={openInPanel} onShowInline={() => setTarget('inline')} />
  }

  return (
    <InlineArtifactCard
      html={html}
      title={title}
      streaming={streaming}
      onOpenInPanel={verified ? openInPanel : undefined}
    />
  )
}

type PanelArtifactChipProps = {
  title: string
  onOpen?: () => void
  onShowInline: () => void
}

const PanelArtifactChip = ({ title, onOpen, onShowInline }: PanelArtifactChipProps) => (
  <div className="mx-4 my-2 flex items-center gap-2 rounded-xl border border-border bg-card pr-2">
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <AppWindow className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">Open artifact in side panel</div>
      </div>
    </button>
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0 rounded-full"
      title="Show inline"
      onClick={onShowInline}
    >
      <Minimize2 className="size-4" />
    </Button>
  </div>
)
