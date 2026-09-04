/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef } from 'react'
import { create } from 'zustand'

/**
 * One-shot composer text waiting to be delivered to a chat, keyed by thread id.
 *
 * The sibling of `usePendingQuotesStore` for whole prompts rather than
 * quote chips: a caller outside the composer's subtree — today a Mini App's
 * `ui/open-chat`, which may arrive before the chat pane has mounted — proposes
 * text, and the composer picks it up whenever it next renders for that thread.
 *
 * It deliberately does *not* write `draft:<id>` in localStorage. That was the
 * first attempt and it delivered nothing: `useDraftInput` reads storage only in
 * its lazy initializer and on a key change, so an already-mounted composer never
 * saw the write — and an unsaved chat runs with `persist: false`, so it never
 * reads storage at all. In-memory and keyed by thread, like the quotes channel.
 */
type PendingPromptStore = {
  promptsByThread: Record<string, string>
  setPrompt: (threadId: string, prompt: string) => void
  clearPrompt: (threadId: string) => void
}

export const usePendingPromptStore = create<PendingPromptStore>((set) => ({
  promptsByThread: {},
  setPrompt: (threadId, prompt) =>
    set((state) => ({ promptsByThread: { ...state.promptsByThread, [threadId]: prompt } })),
  clearPrompt: (threadId) =>
    set((state) => {
      const next = { ...state.promptsByThread }
      delete next[threadId]
      return { promptsByThread: next }
    }),
}))

/** Propose composer text for a thread from outside React. */
export const setPendingPrompt = (threadId: string, prompt: string) =>
  usePendingPromptStore.getState().setPrompt(threadId, prompt)

/**
 * Deliver a pending prompt for `threadId` exactly once, then drop it.
 *
 * Shaped after `useConsumeNavState`: the value is read during render and
 * the handover is deferred with `queueMicrotask`, so neither the consumer's
 * `setState` nor the store write happens while rendering. A ref remembers what
 * was already handed over, so StrictMode's double render can't deliver twice.
 *
 * Clearing matters as much as delivering — a prompt left in the store would be
 * re-seeded every time the composer remounted for that thread, resurrecting
 * text the user had already deleted.
 */
export const useConsumePendingPrompt = (threadId: string, onConsume: (prompt: string) => void): void => {
  const prompt = usePendingPromptStore((state) => state.promptsByThread[threadId] ?? null)
  const consumedRef = useRef<string | null>(null)

  if (prompt === null) {
    consumedRef.current = null
    return
  }

  if (consumedRef.current !== prompt) {
    consumedRef.current = prompt
    queueMicrotask(() => {
      onConsume(prompt)
      usePendingPromptStore.getState().clearPrompt(threadId)
    })
  }
}
