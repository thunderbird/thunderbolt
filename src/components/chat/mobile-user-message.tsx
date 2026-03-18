import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { useLongPress } from '@/hooks/use-long-press'
import { extractTextFromParts } from '@/lib/message-utils'
import type { UIMessage } from 'ai'
import { Copy } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { MessageBubbles } from './message-bubbles'

type MobileUserMessageProps = {
  message: UIMessage
}

export const MobileUserMessage = ({ message }: MobileUserMessageProps) => {
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
