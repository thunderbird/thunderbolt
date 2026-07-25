/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DownloadAppBannerDesktop } from '@/components/download-app-banner-desktop'
import { DownloadAppBannerMobile } from '@/components/download-app-banner-mobile'
import { FloatingHeader } from '@/components/floating-header'
import { Dialog } from '@/components/ui/dialog'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { SidebarInset } from '@/components/ui/sidebar'
import { ArtifactSidebarContent } from '@/content-view/artifact-sidebar-content'
import { defaultOpenWidth, minimumWidthThreshold } from '@/content-view/constants'
import { useContentView } from '@/content-view/context'
import { ObjectSidebarContent } from '@/content-view/object-sidebar-content'
import { SidebarWebview } from '@/content-view/sidebar-webview'
import { Sideview } from '@/content-view/sideview'
import { useIsMobile, useIsNativeMobile } from '@/hooks/use-mobile'
import { edgeSpacing } from '@/lib/constants'
import { isTauri } from '@/lib/platform'
import { useSettings } from '@/hooks/use-settings'
import { animate, AnimatePresence, m } from 'framer-motion'
import { Suspense, useEffect, useRef } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { Outlet } from 'react-router'
import { PageFallback } from '@/loading'

export default function Page() {
  const panelRef = usePanelRef()
  const { state, close, previewHidden } = useContentView()
  const { isMobile } = useIsMobile()
  const isNativeMobile = useIsNativeMobile()
  const { contentViewWidth } = useSettings({
    content_view_width: Number,
  })
  const isOpen = state.type !== null
  const isDesktopPanelOpen = isOpen && !isMobile
  const prevIsDesktopPanelOpen = useRef(isDesktopPanelOpen)
  const lastSavedWidth = useRef<number | null>(null)

  useEffect(() => {
    // Only animate on state changes, not on mount
    if (prevIsDesktopPanelOpen.current !== isDesktopPanelOpen && panelRef.current) {
      if (isDesktopPanelOpen) {
        const savedWidth = contentViewWidth.value
        const hasSavedWidthAboveThreshold = savedWidth && savedWidth >= minimumWidthThreshold
        const targetWidth = hasSavedWidthAboveThreshold ? savedWidth : defaultOpenWidth

        // Opening: animate from 0 to target width
        requestAnimationFrame(() => {
          if (panelRef.current) {
            animate(0, targetWidth, {
              duration: 0.3,
              ease: [0.32, 0.72, 0, 1],
              onUpdate: (latest) => {
                panelRef.current?.resize(`${latest}%`)
              },
            })
          }
        })
      } else {
        // Closing: save current size before animating to 0.
        const currentSize = panelRef.current.getSize().asPercentage
        if (currentSize > 0) {
          lastSavedWidth.current = currentSize
          contentViewWidth.setValue(currentSize)
        }

        animate(currentSize, 0, {
          duration: 0.3,
          ease: [0.32, 0.72, 0, 1],
          onUpdate: (latest) => {
            panelRef.current?.resize(`${latest}%`)
          },
        })
      }
    }
    prevIsDesktopPanelOpen.current = isDesktopPanelOpen
  }, [isDesktopPanelOpen, contentViewWidth])

  // Persist width changes as user resizes (but not on mobile)
  const handleResize = ({ asPercentage }: { asPercentage: number }) => {
    const shouldPersistWidthChange = isOpen && asPercentage > 0 && !isMobile
    if (shouldPersistWidthChange) {
      const hasSignificantWidthChange = !lastSavedWidth.current || Math.abs(asPercentage - lastSavedWidth.current) > 1
      if (hasSignificantWidthChange) {
        lastSavedWidth.current = asPercentage
        contentViewWidth.setValue(asPercentage)
      }
    }
  }

  const contentView = (
    <>
      {state.type === 'preview' && <SidebarWebview config={state.data} onClose={close} hidden={previewHidden} />}
      {state.type === 'object-view' && <ObjectSidebarContent content={state.data} onClose={close} />}
      {state.type === 'sideview' && <Sideview />}
      {state.type === 'artifact' && <ArtifactSidebarContent data={state.data} onClose={close} />}
    </>
  )

  return (
    <SidebarInset className="h-full flex flex-col">
      <ResizablePanelGroup orientation="horizontal">
        {/* 360px is the content floor the create-item container query in
            index.css derives its 840px breakpoint from (480px
            --create-panel-min-width + this 360px = 840px) — if this changes,
            re-derive that literal. */}
        <ResizablePanel minSize={isMobile ? '0%' : '360px'}>
          <div className="relative flex flex-col h-full">
            <FloatingHeader />
            {!isTauri() && (
              <>
                <DownloadAppBannerMobile />
                <DownloadAppBannerDesktop />
              </>
            )}
            <div
              className="flex-1 overflow-auto"
              style={{
                // Reserve the home-indicator safe area, but don't double-count it
                // with the on-screen keyboard: when the keyboard is open (`--kb` > 0)
                // it already covers that region, so subtract it. Without this, the
                // safe-area inset stacks on top of `chat-ui`'s `var(--kb)` and shoves
                // a bottom-anchored input well above the keyboard (THU-586). At rest
                // (`--kb` = 0) this is the full safe-area inset. Native mobile keeps
                // at least the standard 12px edge spacing when the inset is smaller.
                paddingBottom: isNativeMobile
                  ? `max(var(--safe-area-bottom-padding) - var(--kb, 0px), ${edgeSpacing.mobile}px)`
                  : 'max(var(--safe-area-bottom-padding) - var(--kb, 0px), 0px)',
              }}
            >
              <Suspense fallback={<PageFallback />}>
                <Outlet />
              </Suspense>
            </div>
          </div>
        </ResizablePanel>
        {isDesktopPanelOpen && (
          <div className="relative h-full flex">
            <ResizableHandle withHandle className="h-full" />
            {/* 
              Webview cursor mask: When a webview is displayed in the right panel,
              it overlays the resize handle, making the right half non-interactive.
              This div covers the right side to show the correct cursor (default
              instead of ew-resize) over the non-clickable area.
            */}
            {state.type === 'preview' && (
              <div className="absolute inset-y-0 left-1/2 w-2 cursor-default z-10" aria-hidden="true" />
            )}
          </div>
        )}
        {!isMobile && (
          <ResizablePanel
            panelRef={panelRef}
            collapsible
            defaultSize="0%"
            minSize="0%"
            collapsedSize="0%"
            onResize={(panelSize, _id, prevPanelSize) => {
              if (prevPanelSize && prevPanelSize.asPercentage > 0 && panelSize.asPercentage === 0) {
                close()
              }
              handleResize(panelSize)
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
                  {contentView}
                </m.div>
              )}
            </AnimatePresence>
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
      {isMobile && (
        <Dialog open={isOpen} onOpenChange={(nextOpen) => !nextOpen && close()}>
          <ResponsiveModalContentComposable className="gap-0 p-0" flush>
            {contentView}
          </ResponsiveModalContentComposable>
        </Dialog>
      )}
    </SidebarInset>
  )
}
