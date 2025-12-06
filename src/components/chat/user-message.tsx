import type { UIMessage } from 'ai'
import { memo } from 'react'
import { MemoizedMarkdown } from './memoized-markdown'

interface UserMessageProps {
  message: UIMessage
}

export const UserMessage = memo(({ message }: UserMessageProps) => {
  return (
    <>
      {message.parts
        .filter((part) => part.type === 'text')
        .map((part, j) => (
          <div key={j} className="px-4 rounded-2xl max-w-3/4 bg-muted dark:bg-secondary/60 ml-auto mt-6">
            <div className="space-y-2">
              <MemoizedMarkdown id={`${message.id}_${j}`} content={part.text || ''} />
            </div>
          </div>
        ))}
    </>
  )
})
