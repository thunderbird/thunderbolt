/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useArtifactTarget } from '@/artifacts/artifact-target-store'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { Button } from '@/components/ui/button'
import { Minimize2 } from 'lucide-react'
import { type ArtifactViewData } from './context'
import { ContentViewHeader } from './header'

type ArtifactSidebarContentProps = {
  data: ArtifactViewData
  onClose: () => void
}

/**
 * Side-panel view for a verified HTML artifact. Reuses the shared content-view
 * chrome; the header's actions slot hosts the "show inline" toggle, which moves
 * the artifact back into the transcript and closes the panel.
 */
export const ArtifactSidebarContent = ({ data, onClose }: ArtifactSidebarContentProps) => {
  const { setTarget } = useArtifactTarget(data.artifactId, 'panel')

  const handleShowInline = () => {
    setTarget('inline')
    onClose()
  }

  return (
    <div
      className="flex flex-col h-dvh"
      style={{ paddingBottom: 'var(--safe-area-bottom-padding)', paddingTop: 'var(--safe-area-top-padding)' }}
    >
      <ContentViewHeader
        title={data.title}
        onClose={onClose}
        className="bg-card border-b border-border"
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full"
            title="Show inline"
            onClick={handleShowInline}
          >
            <Minimize2 className="size-4" />
          </Button>
        }
      />
      <div className="min-h-0 flex-1 bg-white">
        <SandboxedHtmlFrame html={data.html} title={data.title} />
      </div>
    </div>
  )
}
