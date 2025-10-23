import { parseContentParts } from '@/ai/widget-parser'
import { type TextUIPart } from 'ai'
import { memo } from 'react'
import { StreamingMarkdown } from './streaming-markdown'
import { WidgetRenderer } from './widget-renderer'
import { MemoizedMarkdown } from './memoized-markdown'

interface TextPartProps {
  part: TextUIPart
  messageId: string
}

export const TextPart = memo(({ part, messageId }: TextPartProps) => {
  if (!part.text) return null

  const contentParts = parseContentParts(part.text)

  return (
    <>
      {contentParts.map((contentPart, index) => {
        if (contentPart.type === 'text') {
          return (
            <div key={`text-${index}`} className="p-4 rounded-md my-2" style={{ maxWidth: 'calc(100vw - 2rem)' }}>
              <MemoizedMarkdown key={`${messageId}-text`} id={messageId} content={part.text} />
              {/* <StreamingMarkdown
                content={contentPart.content}
                isStreaming={part.state === 'streaming'}
                className="text-secondary-foreground leading-relaxed"
              /> */}
            </div>
          )
        }
        return (
          <div key={`widget-${index}`} className="animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out">
            <WidgetRenderer widget={contentPart.widget} messageId={messageId} />
          </div>
        )
      })}
    </>
  )
})
