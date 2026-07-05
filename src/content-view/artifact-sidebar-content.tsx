/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ArtifactActions } from '@/components/artifact/artifact-actions'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import { type ArtifactViewData } from './context'
import { ContentViewHeader } from './header'

type ArtifactSidebarContentProps = {
  data: ArtifactViewData
  onClose: () => void
}

/**
 * Side-panel view for a verified HTML artifact. Reuses the shared content-view
 * chrome; closing the panel returns the artifact inline in the transcript (they
 * are two sides of one toggle — it is only ever shown in one place at a time).
 * Post-load runtime errors surface as a strip here too, matching the inline card.
 */
export const ArtifactSidebarContent = ({ data, onClose }: ArtifactSidebarContentProps) => {
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  return (
    <div
      className="flex flex-col h-dvh"
      style={{ paddingBottom: 'var(--safe-area-bottom-padding)', paddingTop: 'var(--safe-area-top-padding)' }}
    >
      <ContentViewHeader
        title={data.title}
        onClose={onClose}
        className="bg-card border-b border-border"
        actions={<ArtifactActions html={data.html} title={data.title} />}
      />
      {runtimeError && (
        <div className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="truncate">{runtimeError}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 bg-white">
        <SandboxedHtmlFrame
          html={data.html}
          title={data.title}
          onReady={() => setRuntimeError(null)}
          onError={setRuntimeError}
        />
      </div>
    </div>
  )
}
