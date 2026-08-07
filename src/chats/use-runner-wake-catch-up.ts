/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Catch a runner-owned thread up when this client wakes.
 *
 * A turn placed on the runner keeps going while the tab is backgrounded or the
 * network is out, and the WebSocket carrying its updates does not survive either.
 * Hydration already catches up on launch; this covers the other two ways a client
 * comes back — the tab regaining focus and the network returning — so an open
 * thread finishes streaming instead of sitting on a stale partial until reload.
 *
 * Catch-up is always `resumeStream()`, never a regenerate: the turn already ran
 * (possibly executing tools), so re-prompting would repeat side effects.
 */

import { useEffect, useEffectEvent } from 'react'
import { useChatStore } from './chat-store'
import { shouldCatchUpOnDetachedTurn } from './use-hydrate-chat-store'

type EventTargetLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

export type WakeSubscriptionTargets = {
  /** Emits `visibilitychange`; `document` in the browser. */
  visibilityTarget?: EventTargetLike
  /** Emits `online`; `window` in the browser. */
  onlineTarget?: EventTargetLike
  /** Whether the app is currently foregrounded. */
  isVisible?: () => boolean
}

/**
 * Subscribe to the two signals that mean "this client can talk to the runner
 * again": the tab becoming visible and the network coming back.
 *
 * @param onWake - invoked on each wake signal
 * @param targets - event sources and the visibility probe; tests inject fakes
 * @returns unsubscribe function
 */
export const subscribeToWakeSignals = (onWake: () => void, targets: WakeSubscriptionTargets = {}): (() => void) => {
  const visibilityTarget = targets.visibilityTarget ?? (typeof document === 'undefined' ? undefined : document)
  const onlineTarget = targets.onlineTarget ?? (typeof window === 'undefined' ? undefined : window)
  const isVisible =
    targets.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible')

  // `visibilitychange` fires on hide too, which is precisely when we must not
  // dial out.
  const handleVisibility = (): void => {
    if (isVisible()) {
      onWake()
    }
  }
  visibilityTarget?.addEventListener('visibilitychange', handleVisibility)
  onlineTarget?.addEventListener('online', onWake)
  return () => {
    visibilityTarget?.removeEventListener('visibilitychange', handleVisibility)
    onlineTarget?.removeEventListener('online', onWake)
  }
}

/**
 * Ask a woken thread to catch up on its runner turn, if it has one to catch up
 * on. Reads the store rather than props so the check always sees the thread's
 * current state, and no-ops for anything that is not an interrupted
 * runner-owned thread.
 *
 * @param sessionId - the chat session (thread) id
 */
export const catchUpOnWake = (sessionId: string): void => {
  const session = useChatStore.getState().sessions.get(sessionId)
  if (!session) {
    return
  }
  const { chatInstance, chatThread, selectedAgent } = session
  if (chatInstance.status === 'streaming' || chatInstance.status === 'submitted') {
    return
  }
  if (!shouldCatchUpOnDetachedTurn(chatThread, selectedAgent, chatInstance.messages)) {
    return
  }
  void chatInstance.resumeStream().catch((err: unknown) => {
    console.error('Runner turn catch-up failed:', err)
  })
}

/**
 * Keep the open thread caught up with its runner turn across tab refocus and
 * network recovery. A legitimate external-subscription effect: it registers DOM
 * listeners and tears them down on unmount.
 *
 * @param sessionId - the chat session (thread) id
 */
export const useRunnerWakeCatchUp = (sessionId: string): void => {
  const onWake = useEffectEvent(() => catchUpOnWake(sessionId))
  useEffect(() => subscribeToWakeSignals(onWake), [])
}
