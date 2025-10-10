import type { ToolUIPart } from 'ai'
import { motion } from 'framer-motion'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useObjectView } from './object-view-provider'
import { ToolIcon } from './tool-icon'
import { ToolItem } from './tool-item'
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
import { useEffect, useState } from 'react'
import { getCloudUrl } from '@/lib/config'
import { FetchContentData, SearchResponseData } from '@/integrations/thunderbolt-pro/tools'
import { markdownToText } from '@/lib/utils'
import { AspectRatio } from '../ui/aspect-ratio'
import { Loader } from '../ai-elements/loader'

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

type ToolGroupProps = {
  tools: ToolUIPart[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
}

export const ToolGroup = ({ tools, isStreaming, isLastPartInMessage, hasTextInMessage }: ToolGroupProps) => {
  const { openObjectSidebar } = useObjectView()

  const { showLoadingNext } = useToolGroupState({
    tools,
    isStreaming,
    isLastPartInMessage,
    hasTextInMessage,
  })

  const [cloudUrl, setCloudUrl] = useState<string>('')

  useEffect(() => {
    getCloudUrl().then(setCloudUrl)
  }, [])

  console.log('DEBUG: tools -> ', tools)

  return (
    <ChainOfThought defaultOpen>
      <ChainOfThoughtHeader />
      <ChainOfThoughtContent>
        {tools.map((tool) => {
          const status = tool.state === 'output-available' ? 'complete' : 'pending'
          const onClick = () => openObjectSidebar(tool)
          console.log('DEBUG: status -> ', status)

          switch (tool.type) {
            case 'tool-search':
              return (
                <ChainOfThoughtStep
                  className="cursor-pointer"
                  key={tool.toolCallId}
                  icon={status === 'complete' ? SearchIcon : Loader}
                  label={status === 'complete' ? 'Search' : 'Searching...'}
                  status={status}
                  onClick={onClick}
                >
                  <ChainOfThoughtSearchResults className="flex-wrap">
                    {(tool.output as SearchResponseData)?.map((data) => {
                      const hostname = new URL(data.url).hostname
                      const favicon = cloudUrl
                        ? `${cloudUrl}/pro/proxy/https://icons.duckduckgo.com/ip3/${hostname}.ico`
                        : null

                      return (
                        <ChainOfThoughtSearchResult key={data.url}>
                          {!!favicon && <img alt={hostname} className="size-4" height={16} src={favicon} width={16} />}
                          {hostname}
                        </ChainOfThoughtSearchResult>
                      )
                    })}
                  </ChainOfThoughtSearchResults>
                </ChainOfThoughtStep>
              )

            case 'tool-fetch_content':
              return (
                <ChainOfThoughtStep
                  className="cursor-pointer"
                  icon={status === 'complete' ? GlobeIcon : Loader}
                  label={
                    status === 'complete' ? ((tool.output as FetchContentData)?.title ?? '') : 'Fetching content...'
                  }
                  status={status}
                  onClick={onClick}
                >
                  {(tool.output as FetchContentData)?.image && cloudUrl && (
                    <ChainOfThoughtImage>
                      <AspectRatio ratio={16 / 4}>
                        <img
                          alt={(tool.output as FetchContentData)?.title ?? ''}
                          // src={`${cloudUrl}/pro/proxy/https://images.gowithguide.com/filters:format(avif)/filters:strip_exif()/fit-in/1024x1024/filters:quality(50)/gowithguide/posts/5175/134268.jpg`}
                          src={`${cloudUrl}/pro/proxy/${(tool.output as FetchContentData)?.image}`}
                          className="h-full w-full object-cover rounded-lg"
                        />
                      </AspectRatio>
                    </ChainOfThoughtImage>
                  )}
                  {(tool.output as FetchContentData)?.text && (
                    <p className="line-clamp-2 mt-2 text-muted-foreground text-xs">
                      {markdownToText((tool.output as FetchContentData)?.text ?? '')}
                    </p>
                  )}
                </ChainOfThoughtStep>
              )

            default:
              null
          }
        })}
        {showLoadingNext && <ChainOfThoughtStep icon={Loader} status="pending" />}
      </ChainOfThoughtContent>
    </ChainOfThought>
  )

  // return (
  //   <div className="*:data-[slot=avatar]:ring-background flex -space-x-2 -space-y-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:grayscale p-1 mt-6 mb-4 flex-wrap">
  //     {tools.map((tool, index) => (
  //       <ToolItem
  //         key={tool.toolCallId ?? `${tool.type}-${index}`}
  //         tool={tool}
  //         index={index}
  //         onOpenDetails={openObjectSidebar}
  //       />
  //     ))}
  //     {showLoadingNext && (
  //       <Tooltip>
  //         <TooltipTrigger asChild>
  //           <motion.div
  //             initial={{ scale: 0 }}
  //             animate={{
  //               scale: 1,
  //             }}
  //           >
  //             <ToolIcon
  //               toolName="processing"
  //               toolOutput={undefined}
  //               Icon={null}
  //               initials="..."
  //               isLoading={true}
  //               isError={false}
  //               tooltipKey="next-action-loading"
  //               onClick={() => {}}
  //             />
  //           </motion.div>
  //         </TooltipTrigger>
  //         <TooltipContent className="max-w-xs">
  //           <p className="font-medium">Thinking...</p>
  //         </TooltipContent>
  //       </Tooltip>
  //     )}
  //   </div>
  // )
}
