import { extractTextFromParts } from '@/lib/message-utils'
import type { UIMessage } from 'ai'
import { useMemo } from 'react'
import { CopyMessageButton } from './copy-message-button'
import { MessageBubbles } from './message-bubbles'

type DesktopUserMessageProps = {
  message: UIMessage
}

export const DesktopUserMessage = ({ message }: DesktopUserMessageProps) => {
  const copyText = useMemo(() => extractTextFromParts(message.parts), [message.parts])

  return (
    <div data-message-id={message.id} className="group">
      <MessageBubbles message={message} />
      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity mt-1">
        <CopyMessageButton text={copyText} />
      </div>
    </div>
  )
}
