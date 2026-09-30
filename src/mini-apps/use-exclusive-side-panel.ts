/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The chat panel and the content-view aside share the right-hand slot, so only
 * one of them may be open (THU-903).
 *
 * Both directions, and both **edge-triggered**, which is the whole design. A
 * single effect closing the chat whenever the aside is open loops: the aside's
 * own "Ask about this" attaches a passage, which opens the chat, which the
 * effect closes, which loses the passage the user just asked about. Closing
 * whichever panel was *already* open when the other arrives has no such cycle,
 * because each effect fires only on its own rising edge.
 *
 * The refs hold the previous value rather than the current one, and are updated
 * inside the effect: reading them during render would make the comparison depend
 * on how many times React chose to render.
 */

import { useEffect, useRef } from 'react'

export type ExclusiveSidePanel = {
  isChatOpen: boolean
  closeChat: () => void
  isAsideOpen: boolean
  closeAside: () => void
}

export const useExclusiveSidePanel = ({ isChatOpen, closeChat, isAsideOpen, closeAside }: ExclusiveSidePanel): void => {
  const previousAsideOpen = useRef(isAsideOpen)
  const previousChatOpen = useRef(isChatOpen)

  useEffect(() => {
    const asideJustOpened = isAsideOpen && !previousAsideOpen.current
    previousAsideOpen.current = isAsideOpen
    if (asideJustOpened && isChatOpen) {
      closeChat()
    }
  }, [isAsideOpen, isChatOpen, closeChat])

  useEffect(() => {
    const chatJustOpened = isChatOpen && !previousChatOpen.current
    previousChatOpen.current = isChatOpen
    if (chatJustOpened && isAsideOpen) {
      closeAside()
    }
  }, [isChatOpen, isAsideOpen, closeAside])
}
