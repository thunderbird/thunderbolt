import { useIsMobile } from '@/hooks/use-mobile'
import type { UIMessage } from 'ai'
import { memo } from 'react'
import { DesktopUserMessage } from './desktop-user-message'
import { MobileUserMessage } from './mobile-user-message'

type UserMessageProps = {
  message: UIMessage
}

export const UserMessage = memo(({ message }: UserMessageProps) => {
  const { isMobile } = useIsMobile()

  if (isMobile) {
    return <MobileUserMessage message={message} />
  }

  return <DesktopUserMessage message={message} />
})

UserMessage.displayName = 'UserMessage'
