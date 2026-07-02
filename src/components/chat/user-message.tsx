/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
