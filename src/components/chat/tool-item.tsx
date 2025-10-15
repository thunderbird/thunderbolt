import type { ToolUIPart } from 'ai'
import { useObjectView } from './object-view-provider'
import { type ComponentType } from 'react'
import type { FetchContentData, SearchResponseData } from '@/integrations/thunderbolt-pro/tools'
import { Loader } from '../ai-elements/loader'
import { motion } from 'framer-motion'
import { useToolMetadata } from '@/hooks/use-tool-metadata'
import { useCloudUrl } from '@/hooks/use-cloud-url'
import { TaskItem, TaskItemFile } from '../ai-elements/task'

type ToolItemProps = {
  tool: ToolUIPart
}

type ToolProps = {
  cloudUrl: string
  onClick: () => void
  status: 'complete' | 'active' | 'pending'
  tool: ToolUIPart
}

type ToolLoaderProps = {
  label: string
  toolId: string
}

const ToolLoader = ({ label, toolId }: ToolLoaderProps) => {
  return (
    <motion.div key={`${toolId}_pending`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <span className="inline-flex items-center gap-2">
        <Loader />
        {label}
      </span>
    </motion.div>
  )
}

const DefaultTool = ({ onClick, status, tool }: ToolProps) => {
  const metadata = useToolMetadata(tool.type)

  const Icon = metadata?.icon

  if (status === 'pending') {
    return <ToolLoader label={metadata?.loadingMessage ?? ''} toolId={tool.toolCallId} />
  }

  return (
    <motion.div key={`${tool.toolCallId}_complete`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <span className="inline-flex items-center gap-2 cursor-pointer" onClick={onClick}>
        {!!Icon && <Icon className="size-4" />}
        {metadata?.displayName}
      </span>
    </motion.div>
  )
}

const SearchTool = ({ onClick, status, tool }: ToolProps) => {
  const metadata = useToolMetadata(tool.type)

  const output = tool.output as SearchResponseData

  const Icon = metadata?.icon

  if (status === 'pending') {
    return <ToolLoader label="Searching" toolId={tool.toolCallId} />
  }

  return (
    <motion.div key={`${tool.toolCallId}_complete`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <span className="inline-flex items-center gap-2 cursor-pointer" onClick={onClick}>
        {!!Icon && <Icon className="size-4" />}
        {metadata?.displayName}
        <TaskItemFile>
          <span>{output.length} found</span>
        </TaskItemFile>
      </span>
    </motion.div>
  )
}

const FetchContentTool = ({ onClick, status, tool }: ToolProps) => {
  const metadata = useToolMetadata(tool.type)

  const output = tool.output as FetchContentData

  const Icon = metadata?.icon

  if (status === 'pending') {
    return <ToolLoader label="Fetching Content" toolId={tool.toolCallId} />
  }

  return (
    <motion.div key={`${tool.toolCallId}_complete`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <span className="inline-flex items-center gap-2 cursor-pointer" onClick={onClick}>
        {!!Icon && <Icon className="size-4" />}
        {output?.title}
      </span>
    </motion.div>
  )
}

const toolsMapper: Record<string, ComponentType<ToolProps>> = {
  default: DefaultTool,
  'tool-search': SearchTool,
  'tool-fetch_content': FetchContentTool,
}

export const ToolItem = ({ tool }: ToolItemProps) => {
  const { openObjectSidebar } = useObjectView()

  const cloudUrl = useCloudUrl()

  const status = tool.state === 'output-available' ? 'complete' : 'pending'
  const onClick = () => openObjectSidebar(tool)

  const ToolComponent = toolsMapper[tool.type] ? toolsMapper[tool.type] : toolsMapper['default']

  return (
    <TaskItem>
      <ToolComponent cloudUrl={cloudUrl} onClick={onClick} status={status} tool={tool} />
    </TaskItem>
  )
}
