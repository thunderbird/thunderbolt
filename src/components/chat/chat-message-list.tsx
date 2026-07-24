/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { RefCallback } from 'react'

import { ChatMessages } from './chat-messages'

type ChatMessageListProps = {
  scrollTargetRef: RefCallback<HTMLDivElement>
}

export const ChatMessageList = ({ scrollTargetRef }: ChatMessageListProps) => (
  <>
    <ChatMessages />
    <div ref={scrollTargetRef} className="shrink-0 !mt-0 h-2 md:h-3" />
  </>
)
