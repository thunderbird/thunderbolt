import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { extractTextFromParts } from '@/lib/message-utils'
import type { UIMessage } from 'ai'
import { Copy } from 'lucide-react'
import { type MouseEvent, useCallback, useMemo, useState } from 'react'
import { MessageBubbles } from './message-bubbles'

type MobileUserMessageProps = {
  message: UIMessage
}

export const MobileUserMessage = ({ message }: MobileUserMessageProps) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const copyText = useMemo(() => extractTextFromParts(message.parts), [message.parts])
  const { copy } = useCopyToClipboard()

  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault()
    setIsMenuOpen(true)
  }, [])

  const handleClose = useCallback(() => setIsMenuOpen(false), [])
  const handleCopy = useCallback(async () => {
    await copy(copyText)
    setIsMenuOpen(false)
  }, [copy, copyText])

  return (
    <div data-message-id={message.id}>
      <div onContextMenu={handleContextMenu} className={isMenuOpen ? 'relative z-50' : undefined}>
        <div className={isMenuOpen ? 'transition-transform scale-[1.02]' : undefined}>
          <MessageBubbles message={message} />
        </div>
        {isMenuOpen && (
          <div className="flex justify-end mt-2">
            <div className="rounded-xl bg-card shadow-lg border overflow-hidden">
              <button
                onClick={handleCopy}
                className="flex items-center gap-3 px-3 py-2 text-sm w-full active:bg-accent"
              >
                <Copy className="size-4 text-muted-foreground" />
                Copy
              </button>
            </div>
          </div>
        )}
      </div>
      {isMenuOpen && <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={handleClose} />}
    </div>
  )
}
