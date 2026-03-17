import type { TextUIPart, UIMessage } from 'ai'
import { memo, useMemo } from 'react'
import { CopyMessageButton } from './copy-message-button'
import { MemoizedMarkdown } from './memoized-markdown'

type UserMessageProps = {
  message: UIMessage
}

export const UserMessage = memo(({ message }: UserMessageProps) => {
  const copyText = useMemo(
    () =>
      message.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part as TextUIPart).text)
        .join('\n\n'),
    [message.parts],
  )

  return (
    <div data-message-id={message.id} className="group">
      {message.parts
        .filter((part) => part.type === 'text')
        .map((part, j) => (
          <div key={j} className="px-4 rounded-2xl max-w-3/4 bg-muted dark:bg-secondary/60 ml-auto mt-6">
            <div className="space-y-2">
              <MemoizedMarkdown id={`${message.id}_${j}`} content={part.text || ''} />
            </div>
          </div>
        ))}
      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity mt-1">
        <CopyMessageButton text={copyText} />
      </div>
    </div>
  )
})
