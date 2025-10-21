import { parseContentParts } from '@/ai/visual-parser'
import { type TextUIPart } from 'ai'
import { memo } from 'react'
import { StreamingMarkdown } from './streaming-markdown'
import { VisualRenderer } from './visual-renderer'

interface TextPartProps {
  part: TextUIPart
  messageId: string
}

// Animation classes for subtle slide-in effect
const animationClasses = 'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out'

export const TextPart = memo(({ part, messageId }: TextPartProps) => {
  if (!part.text) return null

  const contentParts = parseContentParts(part.text)

  return (
    <>
      {contentParts.map((contentPart, index) => {
        if (contentPart.type === 'text') {
          return (
            <div key={`text-${index}`} className="p-4 rounded-md mr-auto w-full my-2">
              <StreamingMarkdown
                content={contentPart.content}
                isStreaming={part.state === 'streaming'}
                className="text-secondary-foreground leading-relaxed"
              />
            </div>
          )
        }
        return (
          <div key={`visual-${index}`} className={animationClasses}>
            <VisualRenderer visual={contentPart.visual} messageId={messageId} />
          </div>
        )
      })}
    </>
  )
})
