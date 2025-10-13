import { getToolMetadata, type ToolMetadata } from '@/lib/tool-metadata'
import { splitPartType } from '@/lib/utils'
import { useEffect, useState } from 'react'

export const useToolMetadata = (toolType: string) => {
  const [, toolName] = splitPartType(toolType)
  const [metadata, setMetadata] = useState<ToolMetadata>()

  useEffect(() => {
    getToolMetadata(toolName).then(setMetadata)
  }, [toolName])

  return metadata
}
