/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { MousePointerClick } from 'lucide-react'
import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { ElementPickOverlay, EmbeddedErrorStrip, SelectionPopover, useElementPicking } from '@/components/embedded'
import { MiniAppFrame } from '@/mini-apps/mini-app-frame'
import { MiniAppDownloadPrompt } from '@/mini-apps/mini-app-download-prompt'
import { useMiniAppBridge } from '@/mini-apps/use-mini-app-bridge'
import type { MiniAppDefinition } from '@/mini-apps/registry'
import { cn } from '@/lib/utils'

type RemoteArtifactSurfaceProps = {
  app: MiniAppDefinition
  owner: string
  onAsk: (passages: string[]) => void
  onChatOpen?: (prompt?: string) => void
  onActivate: () => void
  autoHeight?: boolean
}

/** The remote transport adapter; every display mode keeps the same origin and approval boundary. */
export const RemoteArtifactSurface = ({
  app,
  owner,
  onAsk,
  onChatOpen,
  onActivate,
  autoHeight,
}: RemoteArtifactSurfaceProps) => {
  const openChat = useCallback(
    (prompt?: string) => {
      onActivate()
      onChatOpen?.(prompt)
    },
    [onActivate, onChatOpen],
  )
  const {
    frameRef,
    status,
    selection,
    clearSelection,
    queryElementAt,
    runtimeError,
    handleFrameLoad,
    reloadFrame,
    pendingDownload,
    answerDownload,
  } = useMiniAppBridge({ app, owner, onChatOpen: openChat })
  const ask = useCallback(
    (passages: string[]) => {
      onActivate()
      onAsk(passages)
    },
    [onActivate, onAsk],
  )
  const { mode, startPicking, dismiss, pointAt, pickAt } = useElementPicking({ query: queryElementAt, onAsk: ask })
  const askAboutSelection = () => {
    if (!selection) {
      return
    }
    ask([selection.text])
    clearSelection()
  }
  const showControls = status === 'ready' && mode.kind === 'idle'

  return (
    <div className={cn('relative flex flex-col', autoHeight ? 'h-96' : 'h-full')}>
      <MiniAppFrame app={app} frameRef={frameRef} status={status} onFrameLoad={handleFrameLoad} onRetry={reloadFrame} />
      {runtimeError && <EmbeddedErrorStrip message={runtimeError} className="absolute inset-x-0 top-0 z-20" />}
      {showControls && selection?.rect && <SelectionPopover rect={selection.rect} onAsk={askAboutSelection} />}
      {mode.kind === 'picking' && (
        <ElementPickOverlay element={mode.element} onPoint={pointAt} onPick={pickAt} onCancel={dismiss} />
      )}
      {showControls && (
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2">
          <Button
            onClick={() => {
              onActivate()
              startPicking()
            }}
            variant="secondary"
            size="sm"
            className="rounded-full shadow-lg"
          >
            <MousePointerClick className="size-[var(--icon-size-sm)]" />
            <Trans>Select</Trans>
          </Button>
        </div>
      )}
      <MiniAppDownloadPrompt appName={app.name} download={pendingDownload} onAnswer={answerDownload} />
    </div>
  )
}

export default RemoteArtifactSurface
