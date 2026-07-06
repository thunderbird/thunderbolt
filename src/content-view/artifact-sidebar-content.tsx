/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ArtifactActions } from '@/components/artifact/artifact-actions'
import { ArtifactErrorStrip } from '@/components/artifact/artifact-error-strip'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { useRef, useState } from 'react'
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
  // Clear a stale error only at a reload boundary (a new document). Clearing on `ready` instead
  // would wipe an error the harness reports during initial load — it fires before `ready`, so the
  // user would never see it. Adjusting state during render is the React-blessed reset-on-prop-change.
  const lastHtmlRef = useRef(data.html)
  if (lastHtmlRef.current !== data.html) {
    lastHtmlRef.current = data.html
    setRuntimeError(null)
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
        actions={<ArtifactActions html={data.html} title={data.title} />}
      />
      {runtimeError && <ArtifactErrorStrip message={runtimeError} />}
      <div className="min-h-0 flex-1 bg-white">
        <SandboxedHtmlFrame html={data.html} title={data.title} onError={setRuntimeError} />
      </div>
    </div>
  )
}
