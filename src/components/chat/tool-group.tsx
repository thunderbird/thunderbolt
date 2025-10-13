import type { ToolUIPart } from 'ai'
import { useObjectView } from './object-view-provider'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtImage,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '../ai-elements/chain-of-thought'
import { GlobeIcon, SearchIcon } from 'lucide-react'
import { type ComponentType, useEffect, useState } from 'react'
import { getCloudUrl } from '@/lib/config'
import type { FetchContentData, SearchResponseData } from '@/integrations/thunderbolt-pro/tools'
import { markdownToText } from '@/lib/utils'
import { Loader } from '../ai-elements/loader'
import { AnimatePresence, motion } from 'framer-motion'

type ToolGroupProps = {
  tools: ToolUIPart[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
}

type ToolRenderProps = {
  cloudUrl: string
  onClick: () => void
  status: 'complete' | 'active' | 'pending'
  tool: ToolUIPart
}

type ToolLoaderProps = {
  label: string
  toolId: string
}

type UseToolGroupStateParams = {
  tools: ToolUIPart[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
}

/**
 * Computes the display state for a tool group, including completion status
 * and whether to show a loading indicator for the next action.
 * @internal - Exported for testing only
 */
export const useToolGroupState = ({
  tools,
  isStreaming,
  isLastPartInMessage,
  hasTextInMessage,
}: UseToolGroupStateParams) => {
  const allToolsComplete = tools.every((tool) => tool.state === 'output-available' || tool.state === 'output-error')

  const showLoadingNext = isStreaming && isLastPartInMessage && allToolsComplete && !hasTextInMessage

  return { showLoadingNext, allToolsComplete }
}

const useToolRender = () => {
  const { openObjectSidebar } = useObjectView()

  const [cloudUrl, setCloudUrl] = useState<string>('')

  const renderToolComponent = (tool: ToolUIPart) => {
    const status = tool.state === 'output-available' ? 'complete' : 'pending'
    const onClick = () => openObjectSidebar(tool)

    const ToolComponent = toolsRenderMapper[tool.type]

    if (ToolComponent) {
      return <ToolComponent cloudUrl={cloudUrl} onClick={onClick} status={status} tool={tool} />
    }

    return null
  }

  useEffect(() => {
    getCloudUrl().then(setCloudUrl)
  }, [])

  return { renderToolComponent }
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

const SearchToolRender = ({ cloudUrl, onClick, status, tool }: ToolRenderProps) => {
  if (status === 'pending') {
    return <ToolLoader label="Searching..." toolId={tool.toolCallId} />
  }

  return (
    <motion.div key={`${tool.toolCallId}_complete`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <ChainOfThoughtStep
        className="cursor-pointer"
        icon={SearchIcon}
        label={'Search'}
        status={status}
        onClick={onClick}
      >
        <ChainOfThoughtSearchResults className="flex-wrap">
          {(tool.output as SearchResponseData)?.map((data, urlIndex) => {
            const hostname = new URL(data.url).hostname
            const favicon = cloudUrl ? `${cloudUrl}/pro/proxy/https://icons.duckduckgo.com/ip3/${hostname}.ico` : null

            return (
              <motion.div
                key={data.url}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { delay: urlIndex * 0.1 } }}
              >
                <ChainOfThoughtSearchResult>
                  {!!favicon && <img alt={hostname} className="size-4" height={16} src={favicon} width={16} />}
                  {hostname}
                </ChainOfThoughtSearchResult>
              </motion.div>
            )
          })}
        </ChainOfThoughtSearchResults>
      </ChainOfThoughtStep>
    </motion.div>
  )
}

const FetchContentToolRender = ({ cloudUrl, onClick, status, tool }: ToolRenderProps) => {
  if (status === 'pending') {
    return <ToolLoader label="Fetching content..." toolId={tool.toolCallId} />
  }

  return (
    <motion.div key={`${tool.toolCallId}_complete`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <ChainOfThoughtStep
        className="cursor-pointer"
        icon={GlobeIcon}
        label={(tool.output as FetchContentData)?.title ?? ''}
        status={status}
        onClick={onClick}
      >
        <motion.div key={`${tool.toolCallId}_content`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          {(tool.output as FetchContentData)?.image && cloudUrl && (
            <ChainOfThoughtImage>
              <img
                alt={(tool.output as FetchContentData)?.title ?? ''}
                src={`${cloudUrl}/pro/proxy/${(tool.output as FetchContentData)?.image}`}
                className="h-40 w-full object-cover rounded-lg"
              />
            </ChainOfThoughtImage>
          )}
          {(tool.output as FetchContentData)?.text && (
            <p className="line-clamp-2 mt-2 text-muted-foreground text-xs">
              {markdownToText((tool.output as FetchContentData)?.text ?? '')}
            </p>
          )}
        </motion.div>
      </ChainOfThoughtStep>
    </motion.div>
  )
}

const toolsRenderMapper: Record<string, ComponentType<ToolRenderProps>> = {
  'tool-search': SearchToolRender,
  'tool-fetch_content': FetchContentToolRender,
}

export const ToolGroup = ({ tools, isStreaming, isLastPartInMessage, hasTextInMessage }: ToolGroupProps) => {
  const { showLoadingNext } = useToolGroupState({
    tools,
    isStreaming,
    isLastPartInMessage,
    hasTextInMessage,
  })

  const { renderToolComponent } = useToolRender()

  return (
    <AnimatePresence>
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader />
        <ChainOfThoughtContent>
          {tools.map(renderToolComponent)}
          {showLoadingNext && (
            <ChainOfThoughtStep
              // @ts-ignore
              icon={Loader}
              status="pending"
            />
          )}
        </ChainOfThoughtContent>
      </ChainOfThought>
    </AnimatePresence>
  )
}
