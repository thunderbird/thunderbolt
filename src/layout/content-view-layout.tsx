/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppContentOverlayHost } from '@/components/app-content-overlay'
import { Dialog } from '@/components/ui/dialog'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { SidebarInset } from '@/components/ui/sidebar'
import { ActiveContentView } from '@/content-view/active-content-view'
import { useContentView } from '@/content-view/context'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'
import { AnimatePresence, m } from 'framer-motion'
import type { ReactNode } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { useLocation } from 'react-router'
import { routeHostsContentView } from './content-view-host'
import { contentViewPanelId, getContentViewOpenWidth, useContentViewPanel } from './use-content-view-panel'
import { useBrowserResizeGrip } from './use-browser-resize-grip'

/** Keeps the browser and its native tabs mounted across chat/settings route changes. */
export const ContentViewLayout = ({ children }: { children: ReactNode }) => {
  const panelRef = usePanelRef()
  const { pathname } = useLocation()
  const { state, close, previewHidden } = useContentView()
  const { isMobile } = useIsMobile()
  const { contentViewWidth } = useSettings({
    content_view_width: Number,
  })
  const isOpen = state.type !== null
  // A route that hosts the view itself (`/apps/`) leaves this aside collapsed.
  const drawsDesktopPanel = !isMobile && !routeHostsContentView(pathname)
  const isDesktopPanelOpen = isOpen && drawsDesktopPanel
  const { handleLayoutChanged, beginExternalResize, endExternalResize } = useContentViewPanel({
    isOpen: isDesktopPanelOpen,
    enabled: drawsDesktopPanel,
    panelRef,
    savedWidth: contentViewWidth.value,
    saveWidth: contentViewWidth.setValue,
  })
  const { separatorRef, nativeReady } = useBrowserResizeGrip({
    enabled: isDesktopPanelOpen && state.type === 'preview' && !previewHidden,
    panelRef,
    beginResize: beginExternalResize,
    endResize: endExternalResize,
  })

  return (
    <SidebarInset className="h-full flex flex-col">
      <ResizablePanelGroup
        orientation="horizontal"
        resizeTargetMinimumSize={isDesktopPanelOpen ? { fine: 48, coarse: 48 } : undefined}
        onLayoutChanged={(layout) => {
          void handleLayoutChanged(layout)
        }}
      >
        {/* 360px is the content floor the create-item container query in
            index.css derives its 840px breakpoint from (480px
            --create-panel-min-width + this 360px = 840px) — if this changes,
            re-derive that literal. */}
        <ResizablePanel minSize={isMobile ? '0%' : '360px'} style={{ overflow: 'visible' }}>
          <div className="relative flex h-full min-h-0 flex-col">
            {children}
            {/* The 24px resize strip belongs to the app side of the divider.
                Extend overlays through it so asides meet the actual browser edge. */}
            {isDesktopPanelOpen && state.type === 'preview' && <AppContentOverlayHost className="-right-6" />}
          </div>
        </ResizablePanel>
        {isDesktopPanelOpen && (
          <ResizableHandle
            withHandle
            elementRef={separatorRef}
            data-native-resize-ready={nativeReady || undefined}
            className="z-20 h-full w-6 bg-background after:left-auto after:right-0 after:translate-x-0"
            handleClassName={`absolute top-1/2 left-full h-10 w-6 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-background shadow-xs [&>svg]:size-4 ${nativeReady ? 'opacity-0' : ''}`}
          />
        )}
        {drawsDesktopPanel && (
          <ResizablePanel
            id={contentViewPanelId}
            panelRef={panelRef}
            collapsible
            defaultSize={isDesktopPanelOpen ? `${getContentViewOpenWidth(contentViewWidth.value)}%` : '0%'}
            minSize="0%"
            maxSize={isDesktopPanelOpen ? '100%' : '0%'}
            collapsedSize="0%"
            onResize={(panelSize, _id, prevPanelSize) => {
              if (prevPanelSize && prevPanelSize.asPercentage > 0 && panelSize.asPercentage === 0) {
                close()
              }
            }}
            className="overflow-hidden"
          >
            <AnimatePresence initial={false}>
              {isOpen && (
                <m.div
                  key="sidebar-content"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, delay: 0.15 }}
                  className="h-full"
                >
                  <ActiveContentView />
                </m.div>
              )}
            </AnimatePresence>
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
      {isMobile && (
        <Dialog open={isOpen} onOpenChange={(nextOpen) => !nextOpen && close()}>
          <ResponsiveModalContentComposable className="gap-0 p-0" flush>
            <ActiveContentView />
          </ResponsiveModalContentComposable>
        </Dialog>
      )}
    </SidebarInset>
  )
}
