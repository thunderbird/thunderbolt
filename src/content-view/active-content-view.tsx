/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lazy, Suspense } from 'react'
import { PageFallback } from '@/loading'
import { useContentView } from './context'
import { ObjectSidebarContent } from './object-sidebar-content'
import { SidebarWebview } from './sidebar-webview'
import { Sideview } from './sideview'

/*
 * Lazy, and the only content view that is.
 *
 * It reaches the whole shared element-picking stack — the overlay, the popover,
 * the selection state machine — none of which any other entry-bundle module
 * needs. A static import put roughly a thousand lines of it into the chunk every
 * user downloads to see a chat, for a panel that only opens when someone clicks
 * an artifact. The inline artifact card keeps `SandboxedHtmlFrame` in the entry
 * bundle on purpose, because chat renders artifacts inline; picking is the part
 * that can wait.
 */
const ArtifactSidebarContent = lazy(() =>
  import('./artifact-sidebar-content').then((module) => ({ default: module.ArtifactSidebarContent })),
)

/**
 * Whatever the content view currently holds — an artifact, a tool call or
 * reasoning block, a link preview, a document — or nothing.
 *
 * Owns none of the chrome around it. `main-layout` puts this in its resizable
 * aside (or a full-window dialog on mobile); the Mini App route puts it in a
 * layer over its own chat pane. Each host decides where the view lives and how
 * it arrives; this decides only what is in it.
 */
export const ActiveContentView = () => {
  const { state, close, previewHidden } = useContentView()
  return (
    <>
      {state.type === 'preview' && <SidebarWebview config={state.data} onClose={close} hidden={previewHidden} />}
      {state.type === 'object-view' && <ObjectSidebarContent content={state.data} onClose={close} />}
      {state.type === 'sideview' && <Sideview />}
      {state.type === 'artifact' && (
        <Suspense fallback={<PageFallback />}>
          <ArtifactSidebarContent data={state.data} onClose={close} />
        </Suspense>
      )}
    </>
  )
}
