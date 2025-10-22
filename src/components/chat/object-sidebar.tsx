import { RightSidebarHeader } from '@/components/ui/right-sidebar-header'
import { Sidebar, SidebarContent, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { splitPartType } from '@/lib/utils'
import { type ComponentProps } from 'react'
import { useObjectView } from './object-view-provider'

const getOutput = (part: any) => {
  if (typeof part?.output === 'string') {
    return part?.output
  } else {
    return JSON.stringify(part?.output, null, 2)
  }
}

export function ObjectSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
  const { objectContent, closeObjectSidebar } = useObjectView()
  const { open } = useSidebar()

  const [, toolName] = splitPartType(objectContent?.type ?? '')
  const metadata = getToolMetadataSync(toolName, objectContent?.input)

  return (
    <Sidebar side="right" variant="sidebar" {...props}>
      <RightSidebarHeader title={metadata.displayName} onClose={closeObjectSidebar} className="bg-card" />
      <SidebarContent className="p-4 overflow-x-hidden">
        <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">{getOutput(objectContent)}</p>
      </SidebarContent>
      {open && <SidebarRail enableDrag direction="left" maxResizeWidth="52rem" />}
    </Sidebar>
  )
}
