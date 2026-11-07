/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { artifactPath, type Artifact } from '@/artifacts/artifact'
import { useArtifactPin } from '@/artifacts/use-artifacts'
import { Button } from '@/components/ui/button'
import { useContentView } from '@/content-view/context'
import { useLingui } from '@lingui/react/macro'
import { Maximize2, MessageSquare, PanelRight, Pin, PinOff, Rows3 } from 'lucide-react'
import { useNavigate } from 'react-router'
import { ArtifactActions } from './artifact-actions'

type ArtifactControlsProps = {
  artifact: Artifact
  display: 'inline' | 'sidebar' | 'fullscreen'
  onShowInline?: () => void
  onOpenChat?: () => void
  /** Full-page hosts can move to the conversation while opening its side panel. */
  onOpenInPanel?: () => void
  /** A workspace can change its own arrangement while preserving the mounted conversation. */
  onOpenFullScreen?: () => void
}

/** Pinning and presentation are independent of how an artifact was produced. */
export const ArtifactControls = ({
  artifact,
  display,
  onShowInline,
  onOpenChat,
  onOpenInPanel,
  onOpenFullScreen,
}: ArtifactControlsProps) => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const { showArtifact, close } = useContentView()
  const { pinned, isPending, error, setPinned } = useArtifactPin(artifact.id)
  const pinLabel = pinned ? t`Unpin artifact` : t`Pin artifact`
  const togglePin = async () => {
    try {
      await setPinned(!pinned)
    } catch {
      // The mutation retains the error for the inline retry message below.
    }
  }
  const openFullScreen = () => {
    close()
    navigate(artifactPath(artifact.id))
  }

  return (
    <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {onOpenChat && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          title={t`Chat about artifact`}
          aria-label={t`Chat about artifact`}
          onClick={() => onOpenChat()}
        >
          <MessageSquare className="size-4" />
        </Button>
      )}
      {artifact.source.kind === 'html' && <ArtifactActions html={artifact.source.html} title={artifact.title} />}
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 rounded-full"
        title={pinLabel}
        aria-label={pinLabel}
        aria-pressed={pinned}
        disabled={isPending}
        onClick={togglePin}
      >
        {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
      </Button>
      {display !== 'sidebar' && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          title={t`Open in side panel`}
          aria-label={t`Open in side panel`}
          onClick={onOpenInPanel ?? (() => showArtifact(artifact))}
        >
          <PanelRight className="size-4" />
        </Button>
      )}
      {display !== 'fullscreen' && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          title={t`Open full screen`}
          aria-label={t`Open full screen`}
          onClick={onOpenFullScreen ?? openFullScreen}
        >
          <Maximize2 className="size-4" />
        </Button>
      )}
      {onShowInline && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          title={t`Show inline`}
          aria-label={t`Show inline`}
          onClick={onShowInline}
        >
          <Rows3 className="size-4" />
        </Button>
      )}
      {error && (
        <span
          role="alert"
          className="text-xs text-destructive"
        >{t`Could not update the artifact pin. Try again.`}</span>
      )}
    </div>
  )
}
