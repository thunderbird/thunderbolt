/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lazy, Suspense } from 'react'
import { PageFallback } from '@/loading'
import { useContentView } from './context'
import { ObjectSidebarContent } from './object-sidebar-content'
import { PagePanel } from '@/pages/page-panel'
import { Sideview } from './sideview'

// Summary inspection is off the landing path; chat rendering warms the shared markdown code.
const CompactionSummaryContent = lazy(() =>
  import('@/components/context-usage/compaction-summary-content').then((module) => ({
    default: module.CompactionSummaryContent,
  })),
)

/**
 * Whatever the content view currently holds — an artifact, a tool call or
 * reasoning block, a link preview, a document — or nothing.
 *
 * Owns none of the chrome around it. `main-layout` puts this in its resizable
 * aside (or a full-window dialog on mobile). Each host decides where the view lives and how
 * it arrives; this decides only what is in it.
 */
export const ActiveContentView = (_props: { chatThreadId?: string | null } = {}) => {
  const { state, close, previewHidden } = useContentView()
  return (
    <>
      {state.type === 'preview' && <PagePanel onClose={close} hidden={previewHidden} />}
      {state.type === 'object-view' && <ObjectSidebarContent content={state.data} onClose={close} />}
      {state.type === 'sideview' && <Sideview />}
      {state.type === 'compaction-summary' && (
        <Suspense fallback={<PageFallback />}>
          <CompactionSummaryContent checkpoint={state.data} onClose={close} />
        </Suspense>
      )}
    </>
  )
}
