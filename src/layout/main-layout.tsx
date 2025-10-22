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
import { usePreview } from '@/contexts/preview-context'
import { useSideview } from '@/sideview/provider'
import { Sidebar } from 'lucide-react'
import { useRef } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { Outlet } from 'react-router'
import { Sideview } from './sideview'

export default function Page() {
  const ref = useRef<ImperativePanelHandle>(null)
  const { sideviewId, setSideview } = useSideview()
  const { previewConfig, closePreview, isPreviewOpen } = usePreview()
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
        {(sideviewId || isPreviewOpen) && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              ref={ref}
              collapsible
              defaultSize={20}
              minSize={15}
              onCollapse={() => {
                setSideview(null, null)
                if (isPreviewOpen) closePreview()
              }}
            >
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
                {isPreviewOpen ? <SidebarWebview config={previewConfig} onClose={closePreview} /> : <Sideview />}
              </SidebarContent>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </SidebarInset>
  )
}
