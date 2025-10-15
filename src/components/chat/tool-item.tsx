import type { ToolUIPart } from 'ai'
import { useObjectView } from './object-view-provider'
import {
  ChainOfThoughtImage,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '../ai-elements/chain-of-thought'
import { type ComponentType } from 'react'
import type { FetchContentData, SearchResponseData } from '@/integrations/thunderbolt-pro/tools'
import { markdownToText } from '@/lib/utils'
import { Loader } from '../ai-elements/loader'
import { motion } from 'framer-motion'
import { useToolMetadata } from '@/hooks/use-tool-metadata'
import { useCloudUrl } from '@/hooks/use-cloud-url'

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
      <ChainOfThoughtStep
        // @ts-ignore
        icon={Loader}
        label={label}
        status="pending"
      />
    </motion.div>
  )
}

const DefaultTool = ({ onClick, status, tool }: ToolProps) => {
  const metadata = useToolMetadata(tool.type)

  if (status === 'pending') {
    return <ToolLoader label={metadata?.loadingMessage ?? ''} toolId={tool.toolCallId} />
  }

  return (
    <motion.div key={`${tool.toolCallId}_complete`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <ChainOfThoughtStep
        className="cursor-pointer"
        icon={metadata?.icon ?? undefined}
        label={metadata?.displayName ?? ''}
        status={status}
        onClick={onClick}
      />
    </motion.div>
  )
}

const SearchTool = ({ cloudUrl, onClick, status, tool }: ToolProps) => {
  const metadata = useToolMetadata(tool.type)

  const output = tool.output as SearchResponseData

  if (status === 'pending') {
    return <ToolLoader label={metadata?.loadingMessage ?? ''} toolId={tool.toolCallId} />
  }

  return (
    <motion.div key={`${tool.toolCallId}_complete`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <ChainOfThoughtStep
        className="cursor-pointer"
        icon={metadata?.icon || undefined}
        label={metadata?.displayName ?? ''}
        status={status}
        onClick={onClick}
      >
        <ChainOfThoughtSearchResults className="flex-wrap">
          {output?.map((data, urlIndex) => {
            const hostname = new URL(data.url).hostname
            const favicon = cloudUrl ? `${cloudUrl}/pro/proxy/https://icons.duckduckgo.com/ip3/${hostname}.ico` : null

            return (
              <motion.div
                key={data.url}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { delay: urlIndex * 0.1 } }}
              >
                <a href={data.url} target="_blank" rel="noopener noreferrer">
                  <ChainOfThoughtSearchResult>
                    {!!favicon && <img alt={hostname} className="size-4" height={16} src={favicon} width={16} />}
                    {hostname}
                  </ChainOfThoughtSearchResult>
                </a>
              </motion.div>
            )
          })}
        </ChainOfThoughtSearchResults>
      </ChainOfThoughtStep>
    </motion.div>
  )
}

const FetchContentTool = ({ cloudUrl, status, tool }: ToolProps) => {
  const metadata = useToolMetadata(tool.type)

  const output = tool.output as FetchContentData

  if (status === 'pending') {
    return <ToolLoader label={metadata?.loadingMessage ?? ''} toolId={tool.toolCallId} />
  }

  return (
    <motion.div key={`${tool.toolCallId}_complete`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <a href={output?.url} target="_blank" rel="noopener noreferrer">
        <ChainOfThoughtStep
          className="cursor-pointer"
          icon={metadata?.icon || undefined}
          label={output?.title ?? ''}
          status={status}
        >
          <motion.div key={`${tool.toolCallId}_content`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {output?.image && cloudUrl && (
              <ChainOfThoughtImage>
                <img
                  alt={output?.title ?? ''}
                  src={`${cloudUrl}/pro/proxy/${output?.image}`}
                  className="h-40 w-full object-cover rounded-lg"
                />
              </ChainOfThoughtImage>
            )}
            {output?.text && (
              <p className="line-clamp-2 mt-2 text-muted-foreground text-xs">{markdownToText(output?.text ?? '')}</p>
            )}
          </motion.div>
        </ChainOfThoughtStep>
      </a>
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

  return <ToolComponent cloudUrl={cloudUrl} onClick={onClick} status={status} tool={tool} />
}
