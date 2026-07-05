/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { Button } from '@/components/ui/button'
import { useDeferredVisibility } from '@/hooks/use-deferred-visibility'
import { AlertTriangle, AppWindow, PanelRight } from 'lucide-react'
import { useRef, useState } from 'react'

/** Wait this long after the card mounts before running the artifact's scripts, so the app can finish loading first. */
const artifactActivationDelayMs = 2000

type InlineArtifactCardProps = {
  html: string
  title: string
  /** While true, render a live scripts-off preview of the (partial) HTML as it streams in. */
  streaming?: boolean
  /** Opens the artifact in the side panel; omitted while streaming or when no panel is available. */
  onOpenInPanel?: () => void
}

/**
 * A verified HTML artifact rendered inline in the chat transcript: a titled card
 * with a sandboxed iframe and a control (top-right) to move it to the side panel.
 * While streaming, it shows a live HTML/CSS preview (scripts off) with a
 * "Generating…" indicator; once done it runs scripts and surfaces any runtime
 * error as a strip.
 */
export const InlineArtifactCard = ({ html, title, streaming = false, onOpenInPanel }: InlineArtifactCardProps) => {
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Only run the artifact's scripts once it's on screen and the app has settled.
  const active = useDeferredVisibility(containerRef, artifactActivationDelayMs)

  return (
    <div ref={containerRef} className="mx-4 my-2 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <AppWindow className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
        {streaming ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-current" />
            Generating…
          </span>
        ) : (
          onOpenInPanel && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              title="Open in side panel"
              onClick={onOpenInPanel}
            >
              <PanelRight className="size-4" />
            </Button>
          )
        )}
      </div>
      {!streaming && runtimeError && (
        <div className="flex items-center gap-2 border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="truncate">{runtimeError}</span>
        </div>
      )}
      <SandboxedHtmlFrame
        html={html}
        title={title}
        className="h-[420px]"
        allowScripts={!streaming && active}
        onReady={() => setRuntimeError(null)}
        onError={streaming ? undefined : setRuntimeError}
      />
    </div>
  )
}
