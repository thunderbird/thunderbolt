import type { UIMessage } from 'ai'
import { StreamingMarkdown } from './streaming-markdown'
import { memo } from 'react'

interface UserMessageProps {
  message: UIMessage
}

export const UserMessage = memo(({ message }: UserMessageProps) => {
  return (
    <>
      {message.parts
        .filter((part) => part.type === 'text')
        .map((part, j) => (
          <div key={j} className="p-4 rounded-md max-w-3/4 bg-primary text-primary-foreground ml-auto">
            <div className="space-y-2">
              <StreamingMarkdown content={part.text || ''} className="text-primary-foreground leading-relaxed" />
            </div>
          </div>
        ))}
    </>
  )
})
