import { DownloadAppBannerDesktop } from '@/components/download-app-banner-desktop'
import { DownloadAppBannerMobile } from '@/components/download-app-banner-mobile'
import { Header } from '@/components/ui/header'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { SidebarInset } from '@/components/ui/sidebar'
import { defaultOpenWidth, minimumWidthThreshold } from '@/content-view/constants'
import { useContentView } from '@/content-view/context'
import { ObjectSidebarContent } from '@/content-view/object-sidebar-content'
import { SidebarWebview } from '@/content-view/sidebar-webview'
import { useIsMobile } from '@/hooks/use-mobile'
import { isTauri } from '@/lib/platform'
import { useSettings } from '@/hooks/use-settings'
import { animate, AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { Outlet } from 'react-router'

export default function Page() {
  const ref = useRef<ImperativePanelHandle>(null)
  const { state, close, previewHidden } = useContentView()
  const { isMobile } = useIsMobile()
  const { contentViewWidth } = useSettings({
    content_view_width: Number,
  })
  const isOpen = state.type !== null
  const prevIsOpen = useRef(isOpen)
  const lastSavedWidth = useRef<number | null>(null)

  useEffect(() => {
    // Only animate on state changes, not on mount
    if (prevIsOpen.current !== isOpen && ref.current) {
      if (isOpen) {
        // On mobile: always use 100% width. On desktop: use saved width if above threshold, otherwise use default
        const savedWidth = contentViewWidth.value
        const hasSavedWidthAboveThreshold = savedWidth && savedWidth >= minimumWidthThreshold
        const targetWidth = isMobile ? 100 : hasSavedWidthAboveThreshold ? savedWidth : defaultOpenWidth

        // Opening: animate from 0 to target width
        requestAnimationFrame(() => {
          if (ref.current) {
            animate(0, targetWidth, {
              duration: 0.3,
              ease: [0.32, 0.72, 0, 1],
              onUpdate: (latest) => {
                ref.current?.resize(latest)
              },
            })
          }
        })
      } else {
        // Closing: save current size before animating to 0 (but not on mobile)
        const currentSize = ref.current.getSize()
        const shouldSaveWidthOnClose = currentSize > 0 && !isMobile
        if (shouldSaveWidthOnClose) {
          lastSavedWidth.current = currentSize
          contentViewWidth.setValue(currentSize)
        }

        animate(currentSize, 0, {
          duration: 0.3,
          ease: [0.32, 0.72, 0, 1],
          onUpdate: (latest) => {
            ref.current?.resize(latest)
          },
        })
      }
    }
    prevIsOpen.current = isOpen
  }, [isOpen, isMobile, contentViewWidth])

  // Persist width changes as user resizes (but not on mobile)
  const handleResize = (size: number) => {
    const shouldPersistWidthChange = isOpen && size > 0 && !isMobile
    if (shouldPersistWidthChange) {
      const hasSignificantWidthChange = !lastSavedWidth.current || Math.abs(size - lastSavedWidth.current) > 1
      if (hasSignificantWidthChange) {
        lastSavedWidth.current = size
        contentViewWidth.setValue(size)
      }
    }
  }

  return (
    <SidebarInset className="h-full flex flex-col">
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel>
          <div
            className="flex flex-col h-full"
            style={{
              paddingTop: 'var(--safe-area-top-padding)',
            }}
          >
            <Header />
            {!isTauri() && (
              <>
                <DownloadAppBannerMobile />
                <DownloadAppBannerDesktop />
              </>
            )}
            <div
              className="flex-1 overflow-auto"
              style={{
                paddingBottom: 'var(--safe-area-bottom-padding)',
              }}
            >
              <Outlet />
            </div>
          </div>
        </ResizablePanel>
        {isOpen && !isMobile && (
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
        <ResizablePanel
          ref={ref}
          collapsible
          defaultSize={0}
          minSize={0}
          collapsedSize={0}
          onCollapse={() => close()}
          onResize={handleResize}
          className="overflow-hidden"
        >
          <AnimatePresence initial={false}>
            {isOpen && (
              <motion.div
                key="sidebar-content"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, delay: 0.15 }}
                className="h-full"
              >
                {state.type === 'preview' && (
                  <SidebarWebview config={state.data} onClose={close} hidden={previewHidden} />
                )}
                {state.type === 'object-view' && <ObjectSidebarContent content={state.data} onClose={close} />}
              </motion.div>
            )}
          </AnimatePresence>
        </ResizablePanel>
      </ResizablePanelGroup>
    </SidebarInset>
  )
}
