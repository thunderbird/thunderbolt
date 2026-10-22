/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { SelectableArtifact } from '@/components/artifact/selectable-artifact'
import { EmbeddedErrorStrip } from '@/components/embedded'
import { cn } from '@/lib/utils'
import type { Artifact } from './artifact'
import type { ArtifactContext } from './harness'
import { useArtifactContextStore } from './artifact-context-store'
import { useArtifactSessionStore } from './artifact-session-store'
import { subscribeToIframeFocus } from './iframe-focus'

const RemoteArtifactSurface = lazy(() => import('./remote-artifact-surface'))

export type ArtifactSurfaceProps = {
  artifact: Artifact
  onAsk: (passages: string[]) => void
  onChatOpen?: (prompt?: string) => void
  autoHeight?: boolean
  allowScripts?: boolean
}

type HtmlSurfaceProps = {
  html: string
  title: string
  owner: string
  onAsk: (passages: string[]) => void
  autoHeight: boolean
  allowScripts: boolean
}

const HtmlArtifactSurface = ({ html, title, owner, onAsk, autoHeight, allowScripts }: HtmlSurfaceProps) => {
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const lastHtml = useRef(html)
  if (lastHtml.current !== html) {
    lastHtml.current = html
    setRuntimeError(null)
  }

  const openContext = useEffectEvent(() => useArtifactContextStore.getState().openArtifact(title, owner))

  // Context is an external agent-facing resource, scoped to this rendered document.
  useEffect(() => {
    if (!allowScripts) {
      return
    }
    openContext()
    return () => useArtifactContextStore.getState().closeArtifact(owner)
  }, [html, owner, allowScripts])

  useEffect(() => {
    useArtifactContextStore.getState().renameArtifact(title, owner)
  }, [title, owner, allowScripts])

  const publishContext = useCallback(
    (context: ArtifactContext) => {
      useArtifactContextStore.getState().setContext(context, owner)
    },
    [owner],
  )

  return (
    <div className={cn('flex flex-col', !autoHeight && 'h-full')}>
      {runtimeError && <EmbeddedErrorStrip message={runtimeError} />}
      <div className={cn(!autoHeight && 'min-h-0 flex-1')}>
        <SelectableArtifact
          html={html}
          title={title}
          autoHeight={autoHeight}
          allowScripts={allowScripts}
          onAsk={onAsk}
          onError={setRuntimeError}
          onContextChange={publishContext}
        />
      </div>
    </div>
  )
}

const MountedArtifactSurface = ({
  artifact,
  onAsk,
  onChatOpen,
  autoHeight = false,
  allowScripts = true,
}: ArtifactSurfaceProps) => {
  const [owner] = useState(() => crypto.randomUUID())
  const containerRef = useRef<HTMLDivElement>(null)
  const { id, source } = artifact
  const kind = source.kind

  // One agent-visible owner per mounted surface. Preview-only HTML never registers.
  useEffect(() => {
    if (!allowScripts) {
      return
    }
    useArtifactSessionStore.getState().register({ owner, artifactId: id, kind, inline: autoHeight })
    const unsubscribe = subscribeToIframeFocus((frame) => {
      if (frame && containerRef.current?.contains(frame)) {
        useArtifactSessionStore.getState().activate(owner)
      }
    })
    return () => {
      unsubscribe()
      useArtifactSessionStore.getState().unregister(owner)
    }
  }, [owner, id, kind, autoHeight, allowScripts])

  const activate = useCallback(() => useArtifactSessionStore.getState().activate(owner), [owner])
  const ask = useCallback(
    (passages: string[]) => {
      activate()
      onAsk(passages)
    },
    [activate, onAsk],
  )

  return (
    <div
      ref={containerRef}
      onFocusCapture={activate}
      onPointerDownCapture={activate}
      className={cn(!autoHeight && 'h-full')}
    >
      {source.kind === 'html' ? (
        <HtmlArtifactSurface
          html={source.html}
          title={artifact.title}
          owner={owner}
          onAsk={ask}
          autoHeight={autoHeight}
          allowScripts={allowScripts}
        />
      ) : (
        <Suspense fallback={null}>
          <RemoteArtifactSurface
            app={source.app}
            owner={owner}
            onAsk={ask}
            onChatOpen={onChatOpen}
            onActivate={activate}
            autoHeight={autoHeight}
          />
        </Suspense>
      )}
    </div>
  )
}

/** One rendering entry point for inline, side-panel and full-page artifacts. */
export const ArtifactSurface = (props: ArtifactSurfaceProps) => (
  <MountedArtifactSurface key={props.artifact.id} {...props} />
)
