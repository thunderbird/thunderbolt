import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { useLongPress } from '@/hooks/use-long-press'
import { useIsMobile } from '@/hooks/use-mobile'
import { extractTextFromParts } from '@/lib/message-utils'
import type { UIMessage } from 'ai'
import { Copy } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import { CopyMessageButton } from './copy-message-button'
import { MemoizedMarkdown } from './memoized-markdown'

type UserMessageProps = {
  message: UIMessage
}

const MessageBubbles = ({ message }: UserMessageProps) =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part, j) => (
      <div key={j} className="px-4 rounded-2xl max-w-3/4 bg-muted dark:bg-secondary/60 ml-auto mt-6">
        <div className="space-y-2">
          <MemoizedMarkdown id={`${message.id}_${j}`} content={part.text || ''} />
        </div>
      </div>
    ))

const MobileUserMessage = ({ message }: UserMessageProps) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const copyText = useMemo(() => extractTextFromParts(message.parts), [message.parts])
  const { copy } = useCopyToClipboard()

  const handleOpen = useCallback(() => setIsMenuOpen(true), [])
  const handleClose = useCallback(() => setIsMenuOpen(false), [])
  const handleCopy = useCallback(async () => {
    await copy(copyText)
    setIsMenuOpen(false)
  }, [copy, copyText])

  const longPressHandlers = useLongPress({ onLongPress: handleOpen })

  return (
    <div data-message-id={message.id}>
      <div {...longPressHandlers} className={isMenuOpen ? 'relative z-50 select-none' : 'select-none'}>
        <div className={isMenuOpen ? 'transition-transform scale-[1.02]' : undefined}>
          <MessageBubbles message={message} />
        </div>
        {isMenuOpen && (
          <div className="flex justify-end mt-2">
            <div className="rounded-xl bg-card shadow-lg border overflow-hidden">
              <button
                onClick={handleCopy}
                className="flex items-center justify-between gap-8 px-4 py-3 text-sm w-full active:bg-accent"
              >
                Copy
                <Copy className="size-4 text-muted-foreground" />
              </button>
            </div>
          </div>
        )}
      </div>
      {isMenuOpen && <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={handleClose} />}
    </div>
  )
}

const DesktopUserMessage = ({ message }: UserMessageProps) => {
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

export const UserMessage = memo(({ message }: UserMessageProps) => {
  const { isMobile } = useIsMobile()

  if (isMobile) {
    return <MobileUserMessage message={message} />
  }

  return <DesktopUserMessage message={message} />
})

UserMessage.displayName = 'UserMessage'
