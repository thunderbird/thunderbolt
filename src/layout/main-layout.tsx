import { ObjectSidebarContent } from '@/components/chat/object-sidebar-content'
import { SidebarWebview } from '@/components/sidebar-webview'
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
import { useRightSidebar } from '@/contexts/right-sidebar-context'
import { Sidebar } from 'lucide-react'
import { useRef } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { Outlet } from 'react-router'
import { Sideview } from './sideview'

export default function Page() {
  const ref = useRef<ImperativePanelHandle>(null)
  const { state, close } = useRightSidebar()
  const isOpen = state.type !== null

  return (
    <SidebarInset className="h-full overflow-hidden flex flex-col">
      <ResizablePanelGroup direction="horizontal" autoSaveId="sideview" className="h-full">
        <ResizablePanel>
          <div className="flex flex-col h-full">
            <Header />
            <div className="flex-1 overflow-hidden">
              <Outlet />
            </div>
          </div>
        </ResizablePanel>
        {isOpen && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              ref={ref}
              collapsible
              defaultSize={20}
              minSize={15}
              onCollapse={() => {
                close()
              }}
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
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </SidebarInset>
  )
}
