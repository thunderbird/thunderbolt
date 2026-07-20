/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { useChatScrollHandler } from '@/chats/use-chat-scroll-handler'
import { ChatMessages } from './chat-messages'
import { ChatPromptInput } from './chat-prompt-input'
import { PermissionDialogHost } from './permission-dialog-host'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useChat } from '@ai-sdk/react'
import { statusOnlyThrottleMs } from '@/chats/chat-throttle'
import { useChatAutomation } from '@/chats/use-chat-automation'
import { ScrollToBottomButton } from './scroll-to-bottom-button'
import { AppLogo } from '../app-logo'
import { getGreeting } from './chat-ui-greeting'

const EmptyChatGreeting = () => {
  return (
    <div className="flex items-center gap-5">
      <AppLogo size={72} className="opacity-60" />
      <span className="font-heading text-3xl font-medium text-muted-foreground">{getGreeting()}</span>
    </div>
  )
}

export default function ChatUI() {
  const { chatInstance } = useCurrentChatSession()

  // ChatUI only needs the structural "are there any messages" signal (to switch
  // between the empty-state logo and the message list), not per-token content —
  // the message list is rendered by the memoized `ChatMessages`, which owns its
  // own render-throttled messages subscription. Subscribing here at the coarse
  // status-only cadence keeps ChatUI (and its framer-motion `layout` divs) from
  // re-rendering on every streamed token. `status` is a separate, unthrottled
  // useChat subscription (only the messages callback is throttled), so reading
  // it here stays instant regardless of the coarse messages cadence.
  const { messages, status } = useChat({ chat: chatInstance, experimental_throttle: statusOnlyThrottleMs })

  useChatAutomation()

  // Fold the unthrottled `status` into the structural signal: a send within
  // `statusOnlyThrottleMs` of a prior messages notification (hydration on fresh
  // mount, regenerate, quick follow-up) lands on throttleit's trailing edge, so
  // the throttled `messages.length` can read stale 0 for up to that window. The
  // instant `submitted`/`streaming` transition mounts the list immediately.
  const hasMessages = messages.length > 0 || status === 'submitted' || status === 'streaming'

  const { isAtBottom, scrollContainerRef, scrollHandlers, scrollTargetRef, scrollToBottom, scrollToBottomAndActivate } =
    useChatScrollHandler()

  const { isMobile } = useIsMobile()

  // Scroll to bottom instantly when entering an existing chat
  // Effect re-runs when scrollToBottom changes (when container becomes available)
  const hasScrolledInitially = useRef(false)
  useEffect(() => {
    if (hasMessages && !hasScrolledInitially.current) {
      // scrollToBottom returns true if scroll was performed, false if container not ready
      // Only mark as scrolled when it actually succeeds
      const scrolled = scrollToBottom(false)
      if (scrolled) {
        hasScrolledInitially.current = true
      }
    }
  }, [hasMessages, scrollToBottom])

  return (
    <div className="h-full w-full" style={{ paddingBottom: 'var(--kb, 0px)' }}>
      <div className={cn('flex flex-col h-full overflow-hidden w-full', isMobile && 'pb-0')}>
        <AnimatePresence mode="wait">
          {hasMessages ? (
            <div key="messages" className="relative flex-1 min-h-0">
              <m.div
                ref={scrollContainerRef}
                {...scrollHandlers}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full overflow-y-auto hide-scrollbar"
              >
                {/* Scroll captures the full width; the content stays centered.
                    Top padding clears the floating header (the layout's scrim
                    keeps scrolled messages legible behind it). */}
                <div className="mx-auto w-full min-w-[300px] max-w-[728px] space-y-4 px-3 pt-[calc(var(--header-inset)+1rem)] pb-0 md:px-4">
                  <ChatMessages />
                  <div ref={scrollTargetRef} className="shrink-0 !mt-0 h-2 md:h-3" />
                </div>
              </m.div>
              <ScrollToBottomButton
                isVisible={!isAtBottom}
                onClick={() => scrollToBottomAndActivate(true)}
                className="bottom-6 md:bottom-7"
              />
            </div>
          ) : isMobile ? (
            <m.div
              key="logo"
              className="flex-1 flex items-center justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <AppLogo size={88} className="opacity-60" />
            </m.div>
          ) : null}
        </AnimatePresence>

        <m.div
          className={cn(
            '-mt-3 md:-mt-4 relative z-10 px-3 pb-3 md:px-4 md:pb-4 flex',
            !hasMessages && !isMobile && 'flex-1 items-center',
          )}
          initial={false}
          layout
          transition={{
            type: 'tween',
            ease: [0.2, 0.9, 0.1, 1],
            duration: 0.25,
          }}
        >
          <m.div
            className="flex flex-col items-center w-full"
            layout
            transition={{
              type: 'tween',
              ease: [0.2, 0.9, 0.1, 1],
              duration: 0.25,
            }}
          >
            {!hasMessages && !isMobile && (
              <m.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-24">
                <EmptyChatGreeting />
              </m.div>
            )}
            <div className="w-full max-w-[696px] min-w-[268px]">
              <PermissionDialogHost />
            </div>
            <m.div
              className="w-full max-w-[696px] min-w-[268px] rounded-2xl"
              layout
              transition={{
                type: 'tween',
                ease: [0.2, 0.9, 0.1, 1],
                duration: 0.25,
              }}
            >
              <ChatPromptInput />
            </m.div>
          </m.div>
        </m.div>
      </div>
    </div>
  )
}
