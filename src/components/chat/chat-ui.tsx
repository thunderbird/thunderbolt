/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useIsMobile, useIsNativeMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { AnimatePresence, m, type Transition } from 'framer-motion'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useChatScrollHandler } from '@/chats/use-chat-scroll-handler'
import { useScrollToMessage } from '@/chats/use-scroll-to-message'
import { loadChatMessageList } from './chat-messages-loader'
import { ChatPromptInput } from './chat-prompt-input'
import { PermissionDialogHost } from './permission-dialog-host'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useChat } from '@ai-sdk/react'
import { statusOnlyThrottleMs } from '@/chats/chat-throttle'
import { useChatAutomation } from '@/chats/use-chat-automation'
import { ScrollToBottomButton } from './scroll-to-bottom-button'
import { AppLogo } from '../app-logo'
import { getGreeting } from './chat-ui-greeting'
import { useLingui } from '@lingui/react/macro'

const ChatMessageList = lazy(() => loadChatMessageList().then((module) => ({ default: module.ChatMessageList })))

// One tween drives the whole first-send choreography — the composer's
// center→bottom slide and the message list's entrance — so every moving
// surface follows the same curve and settles together.
const firstSendTween: Transition = { type: 'tween', ease: [0.2, 0.9, 0.1, 1], duration: 0.25 }

const EmptyChatGreeting = () => {
  const { i18n } = useLingui()

  return (
    // The logo's transparent padding shifts the combined ink bounds 10px right, so compensate to optically center them.
    <div className="-translate-x-2.5 flex items-center gap-5">
      <AppLogo size={72} className="opacity-60" />
      <span className="font-heading text-3xl font-medium text-muted-foreground">{i18n._(getGreeting())}</span>
    </div>
  )
}

export default function ChatUI() {
  const { i18n } = useLingui()
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

  const {
    isAtBottom,
    scrollContainerRef,
    scrollHandlers,
    scrollTargetRef,
    scrollToBottom,
    scrollToBottomAndActivate,
    scrollToMessage,
  } = useChatScrollHandler()

  // Track the scroll container element as state (not just via the hook's
  // callback ref) so `useScrollToMessage`'s wait-for-element effect re-runs
  // when the container attaches. Compose with the hook's ref so auto-scroll
  // still owns the element too.
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null)
  const setScrollContainer = useCallback(
    (el: HTMLDivElement | null) => {
      setScrollContainerEl(el)
      scrollContainerRef(el)
    },
    [scrollContainerRef],
  )

  useScrollToMessage({ scrollContainer: scrollContainerEl, scrollToMessage, messages })

  const { isMobile } = useIsMobile()
  const isNativeMobile = useIsNativeMobile()

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
              {/* Mobile keeps the composer bottom-anchored, so there is no
                  layout change for framer to slide on the first send (desktop
                  gets its slide from the composer's center→bottom `layout`
                  animation). Slide the list itself up instead, matching the
                  composer tween, so mobile mirrors the desktop motion. */}
              <m.div
                ref={setScrollContainer}
                {...scrollHandlers}
                initial={{ opacity: 0, y: isMobile ? 24 : 0 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={firstSendTween}
                className="h-full overflow-y-auto hide-scrollbar"
              >
                {/* Scroll captures the full width; the content stays centered.
                    Top padding clears the floating header (--header-inset)
                    plus 1.5rem of breathing room so the first message doesn't
                    sit flush against the header's scrim (which keeps scrolled
                    messages legible behind it). */}
                <div className="mx-auto w-full min-w-[300px] max-w-[728px] space-y-4 px-3 pt-[calc(var(--header-inset)+1.5rem)] pb-0 md:px-4">
                  <Suspense fallback={null}>
                    <ChatMessageList scrollTargetRef={scrollTargetRef} />
                  </Suspense>
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
              className="flex flex-1 flex-col items-center justify-center gap-4 text-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              // Fast exit: with `mode="wait"` the logo's fade-out gates the
              // message list's slide-in, so a leisurely default (~0.3s) would
              // hold the just-sent message invisible for that long.
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
            >
              <AppLogo size={72} className="opacity-60" />
              <span className="font-heading text-2xl font-medium text-muted-foreground">{i18n._(getGreeting())}</span>
            </m.div>
          ) : null}
        </AnimatePresence>

        <m.div
          className={cn(
            'relative z-10 px-3 pb-3 md:px-4 md:pb-4 flex',
            isNativeMobile && 'pb-0',
            !hasMessages && !isMobile && 'flex-1 items-center',
          )}
          initial={false}
          layout
          transition={firstSendTween}
        >
          <m.div className="flex flex-col items-center w-full" layout transition={firstSendTween}>
            {/* Exit fade so the greeting dissolves while the composer slides
                down on the first send — without it the greeting pops out
                abruptly, which reads as a hitch in the otherwise-smooth
                new-chat → real-chat transition. */}
            <AnimatePresence>
              {!hasMessages && !isMobile && (
                <m.div
                  key="greeting"
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  className="mb-24"
                >
                  <EmptyChatGreeting />
                </m.div>
              )}
            </AnimatePresence>
            <div className="w-full max-w-[696px] min-w-[268px]">
              <PermissionDialogHost />
            </div>
            <m.div className="w-full max-w-[696px] min-w-[268px] rounded-2xl" layout transition={firstSendTween}>
              <ChatPromptInput />
            </m.div>
          </m.div>
        </m.div>
      </div>
    </div>
  )
}
