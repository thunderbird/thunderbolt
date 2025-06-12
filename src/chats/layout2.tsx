import { MobileHeader } from '@/components/mobile-header'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenuButton, SidebarProvider } from '@/components/ui/sidebar'
import { useSideview } from '@/sideview/provider'
import { Sidebar } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ImperativePanelHandle } from 'react-resizable-panels'
import { Outlet } from 'react-router'
import ChatSidebar from './sidebar'
import { Sideview } from './sideview'

export default function Page() {
  const ref = useRef<ImperativePanelHandle>(null)
  const { sideviewId, setSideview } = useSideview()

  // Initialize sidebar state from localStorage to sync with settings
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('sidebar-state')
    return saved ? JSON.parse(saved) : true
  })

  // Save sidebar state to localStorage whenever it changes
  const handleSidebarChange = (open: boolean) => {
    setSidebarOpen(open)
    localStorage.setItem('sidebar-state', JSON.stringify(open))
  }

  useEffect(() => {
    if (sideviewId) {
      ref.current?.expand()
    } else {
      ref.current?.collapse()
    }
  }, [sideviewId])

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={handleSidebarChange}>
      <ChatSidebar />
      <SidebarInset className="h-full overflow-hidden flex flex-col">
        <ResizablePanelGroup direction="horizontal" autoSaveId="sideview" className="h-full">
          <ResizablePanel>
            <div className="flex flex-col h-full">
              <MobileHeader />
              <div className="flex-1 overflow-hidden">
                <Outlet />
              </div>
            </div>
          </ResizablePanel>
          {sideviewId && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel ref={ref} collapsible defaultSize={20} minSize={15} onCollapse={() => setSideview(null, null)}>
                <SidebarHeader>
                  <SidebarGroup>
                    <SidebarGroupContent className="flex justify-end w-full flex-1 items-center">
                      <SidebarMenuButton onClick={() => ref?.current?.collapse()} className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer" tooltip="Close Panel">
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
    </SidebarProvider>
  )
}
