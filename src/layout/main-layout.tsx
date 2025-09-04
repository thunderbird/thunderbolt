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
import { useSideview } from '@/sideview/provider'
import { Sidebar } from 'lucide-react'
import { useRef } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { Outlet } from 'react-router'
import { Sideview } from './sideview'

export default function Page() {
  const ref = useRef<ImperativePanelHandle>(null)
  const { sideviewId, setSideview } = useSideview()
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
        {sideviewId && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              ref={ref}
              collapsible
              defaultSize={20}
              minSize={15}
              onCollapse={() => setSideview(null, null)}
            >
              <SidebarHeader>
                <SidebarGroup>
                  <SidebarGroupContent className="flex justify-end w-full flex-1 items-center">
                    <SidebarMenuButton
                      onClick={() => ref?.current?.collapse()}
                      className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer"
                      tooltip="New Chat"
                    >
                      <Sidebar />
                    </SidebarMenuButton>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarHeader>
              <SidebarContent className="w-full h-full overflow-scroll">
                <Sideview />
              </SidebarContent>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </SidebarInset>
  )
}
