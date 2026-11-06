/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A chat that opens while an aside covers it wants to be seen, so the aside
 * steps out of the way.
 *
 * The aside is layered over the chat in the Mini App's side pane, and most of
 * the time that is the right order — an artifact or a reasoning block was
 * opened *from* the conversation, and closing it reveals the conversation.
 * But some things open the chat from outside: the app's own `ui/open-chat`, a
 * passage picked out of the app, a thread chosen in the nav sidebar. Each of
 * those would land under the aside, invisible, with the user left to guess
 * that something happened.
 *
 * **Edge-triggered**, on the chat's rising edge only. A level rule — close the
 * aside whenever both are open — would also fire the other way round, shutting
 * an aside the user just opened over a chat that was already there (THU-903
 * hit the same cycle from the other side).
 *
 * The previous value is seeded `false` rather than from the current one, so
 * mounting with both already open — an app chat opened from the sidebar while
 * an aside was up on the previous route — counts as the chat arriving, and the
 * aside yields. The chat's open state is the user's own, held in `?chat=`; the
 * aside is transient.
 */

import { useEffect, useRef } from 'react'

export type AsideYieldsToChat = {
  isChatOpen: boolean
  isAsideOpen: boolean
  closeAside: () => void
}

export const useAsideYieldsToChat = ({ isChatOpen, isAsideOpen, closeAside }: AsideYieldsToChat): void => {
  // Updated inside the effect, not during render: reading it there would make
  // the comparison depend on how many times React chose to render.
  const previousChatOpen = useRef(false)

  useEffect(() => {
    const chatJustOpened = isChatOpen && !previousChatOpen.current
    previousChatOpen.current = isChatOpen
    if (chatJustOpened && isAsideOpen) {
      closeAside()
    }
  }, [isChatOpen, isAsideOpen, closeAside])
}
