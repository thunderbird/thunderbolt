/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ArtifactActions } from '@/components/artifact/artifact-actions'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
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
 */
export const ArtifactSidebarContent = ({ data, onClose }: ArtifactSidebarContentProps) => {
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
      <div className="min-h-0 flex-1 bg-white">
        <SandboxedHtmlFrame html={data.html} title={data.title} />
      </div>
    </div>
  )
}
