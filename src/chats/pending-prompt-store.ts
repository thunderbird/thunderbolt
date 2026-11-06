/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useEffectEvent, useRef } from 'react'
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
 * Merge a proposed prompt into whatever the composer already holds.
 *
 * The prompt used to replace the draft outright, which was documented as an
 * acceptable trade and is not: the draft is the user's own typing, and the
 * proposal comes from an app acting on its own initiative. Appending keeps
 * both and lets the user edit before sending.
 *
 * Idempotent on the tail, so a prompt already sitting at the end of the draft
 * is not appended twice — a remount that re-delivers the same text would
 * otherwise stutter it.
 */
export const mergeIntoDraft = (draft: string, prompt: string): string => {
  if (draft.trim().length === 0) {
    return prompt
  }
  return draft.trimEnd().endsWith(prompt.trim()) ? draft : `${draft.trimEnd()}\n\n${prompt}`
}

/**
 * Deliver a pending prompt for `threadId` exactly once, then drop it.
 *
 * The handover runs in an effect, so it happens for a render that *committed*.
 * It used to run during render, deferred with `queueMicrotask` — which kept the
 * store write out of the render pass but not out of an abandoned render: React
 * is free to throw a render away (StrictMode, a concurrent retry, a suspended
 * sibling), and the microtask it had already queued ran anyway. That cleared the
 * prompt on behalf of a composer that never existed, and the text was gone
 * before anything could show it.
 *
 * `useEffectEvent` for the callback: the consumer passes a fresh closure every
 * render, and listing it as a dependency would re-run the delivery on renders
 * where nothing about the prompt changed.
 *
 * Clearing matters as much as delivering — a prompt left in the store would be
 * re-seeded every time the composer remounted for that thread, resurrecting
 * text the user had already deleted.
 */
export const useConsumePendingPrompt = (threadId: string, onConsume: (prompt: string) => void): void => {
  const prompt = usePendingPromptStore((state) => state.promptsByThread[threadId] ?? null)
  const deliver = useEffectEvent((value: string) => onConsume(value))
  /*
   * What has already been handed over.
   *
   * The effect is not enough on its own: StrictMode mounts, unmounts and
   * remounts, so the effect body runs twice against the same value and
   * delivered the prompt twice. The marker is reset when the store goes empty
   * — which happens immediately after a delivery — so the *same* text proposed
   * again later is still a new delivery rather than a duplicate.
   *
   * Written here rather than during render, which is the whole point: a render
   * React abandons leaves nothing behind.
   */
  const deliveredRef = useRef<string | null>(null)

  useEffect(() => {
    if (prompt === null) {
      deliveredRef.current = null
      return
    }
    if (deliveredRef.current === prompt) {
      return
    }
    deliveredRef.current = prompt
    deliver(prompt)
    usePendingPromptStore.getState().clearPrompt(threadId)
  }, [prompt, threadId])
}
