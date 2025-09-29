import { type ComponentProps } from 'react'
import { Sidebar, SidebarContent, SidebarHeader, SidebarRail } from '@/components/ui/sidebar'
import { Button } from '../ui/button'
import { useObjectView } from './object-view-provider'
import { X } from 'lucide-react'
import { splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'

const getOutput = (part: any) => {
  if (typeof part?.output === 'string') {
    return part?.output
  } else {
    return JSON.stringify(part?.output, null, 2)
  }
}

export function ObjectSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
  const { objectContent, closeObjectSidebar } = useObjectView()

  const [, toolName] = splitPartType(objectContent?.type ?? '')
  const metadata = getToolMetadataSync(toolName, objectContent?.input)

  return (
    <Sidebar side="right" variant="sidebar" {...props}>
      <SidebarHeader className="flex-row justify-between items-center flex bg-card">
        <h2 className="text-lg font-semibold truncate">{metadata.displayName}</h2>
        <Button onClick={closeObjectSidebar} variant="ghost" size="sm">
          <X />
        </Button>
      </SidebarHeader>
      <SidebarContent className="p-4 overflow-x-hidden">
        <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">{getOutput(objectContent)}</p>
      </SidebarContent>
      <SidebarRail enableDrag direction="left" maxResizeWidth="52rem" />
    </Sidebar>
  )
}
