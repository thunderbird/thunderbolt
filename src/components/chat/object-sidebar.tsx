import { Sidebar, SidebarContent, SidebarHeader, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { useObjectView } from './object-view-provider'
import { SidebarCloseButton } from '@/components/ui/sidebar-close-button'
import { type ComponentProps } from 'react'

export function ObjectSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
  const { objectContent, closeObjectSidebar } = useObjectView()
  const { open } = useSidebar()

  return (
    <Sidebar side="right" variant="sidebar" {...props}>
      <SidebarHeader className="flex-row justify-between items-center flex bg-card">
        <h2 className="text-lg font-semibold truncate">{objectContent?.title}</h2>
        <SidebarCloseButton onClick={closeObjectSidebar} />
      </SidebarHeader>
      <SidebarContent className="p-4 overflow-x-hidden">
        <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">{objectContent?.content}</p>
      </SidebarContent>
      {open && <SidebarRail enableDrag direction="left" maxResizeWidth="52rem" />}
    </Sidebar>
  )
}
