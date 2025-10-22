import { Header } from '@/components/ui/header'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenuButton,
} from '@/components/ui/sidebar'
import { useRightSidebar } from '@/right-sidebar/context'
import { ObjectSidebarContent } from '@/right-sidebar/object-sidebar-content'
import { SidebarWebview } from '@/right-sidebar/sidebar-webview'
import { Sideview } from '@/right-sidebar/sideview'
import { animate, AnimatePresence, motion } from 'framer-motion'
import { Sidebar } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { Outlet } from 'react-router'

export default function Page() {
  const ref = useRef<ImperativePanelHandle>(null)
  const { state, close } = useRightSidebar()
  const isOpen = state.type !== null
  const prevIsOpen = useRef(isOpen)

  useEffect(() => {
    // Only animate on state changes, not on mount
    if (prevIsOpen.current !== isOpen && ref.current) {
      if (isOpen) {
        // Opening: animate from 0 to 50
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (ref.current) {
              animate(0, 50, {
                duration: 0.3,
                ease: [0.32, 0.72, 0, 1],
                onUpdate: (latest) => {
                  ref.current?.resize(latest)
                },
              })
            }
          })
        })
      } else {
        // Closing: animate from current size to 0
        const currentSize = ref.current.getSize()
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
  }, [isOpen])

  return (
    <SidebarInset className="h-full overflow-hidden flex flex-col">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        <ResizablePanel>
          <div className="flex flex-col h-full">
            <Header />
            <div className="flex-1 overflow-hidden">
              <Outlet />
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          ref={ref}
          collapsible
          defaultSize={isOpen ? 50 : 0}
          minSize={0}
          collapsedSize={0}
          onCollapse={() => close()}
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
                {state.type === 'preview' && <SidebarWebview config={state.data} onClose={close} />}
                {state.type === 'object-view' && <ObjectSidebarContent content={state.data} onClose={close} />}
                {state.type === 'sideview' && (
                  <>
                    <SidebarHeader>
                      <SidebarGroup>
                        <SidebarGroupContent className="flex justify-end w-full flex-1 items-center">
                          <SidebarMenuButton
                            onClick={() => ref?.current?.collapse()}
                            className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer"
                            tooltip="Close"
                          >
                            <Sidebar />
                          </SidebarMenuButton>
                        </SidebarGroupContent>
                      </SidebarGroup>
                    </SidebarHeader>
                    <SidebarContent className="w-full h-full overflow-scroll">
                      <Sideview />
                    </SidebarContent>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </ResizablePanel>
      </ResizablePanelGroup>
    </SidebarInset>
  )
}
