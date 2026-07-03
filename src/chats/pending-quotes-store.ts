/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QuoteData } from '@/types'
import { create } from 'zustand'

/**
 * Pending quote-reply passages for the composer, keyed by chat thread id.
 *
 * This is the channel between the "Reply" button — which lives deep in the
 * assistant message list — and the composer, which owns the send. Both address
 * the same thread via `useCurrentChatSession().id`, so neither has to know about
 * the other. In-memory (not persisted): a pending quote is transient composer
 * state, like the pending attachment chips. Keyed by thread so quotes don't
 * bleed across threads while the composer stays mounted.
 */
type PendingQuotesStore = {
  quotesByThread: Record<string, QuoteData[]>
  addQuote: (threadId: string, quote: QuoteData) => void
  removeQuote: (threadId: string, index: number) => void
  setQuotes: (threadId: string, quotes: QuoteData[]) => void
  clearQuotes: (threadId: string) => void
}

export const usePendingQuotesStore = create<PendingQuotesStore>((set) => ({
  quotesByThread: {},
  addQuote: (threadId, quote) =>
    set((state) => ({
      quotesByThread: {
        ...state.quotesByThread,
        [threadId]: [...(state.quotesByThread[threadId] ?? []), quote],
      },
    })),
  removeQuote: (threadId, index) =>
    set((state) => ({
      quotesByThread: {
        ...state.quotesByThread,
        [threadId]: (state.quotesByThread[threadId] ?? []).filter((_, i) => i !== index),
      },
    })),
  setQuotes: (threadId, quotes) =>
    set((state) => ({ quotesByThread: { ...state.quotesByThread, [threadId]: quotes } })),
  clearQuotes: (threadId) =>
    set((state) => {
      const next = { ...state.quotesByThread }
      delete next[threadId]
      return { quotesByThread: next }
    }),
}))

/** Stable empty reference so threads with no quotes don't churn selector snapshots. */
const emptyQuotes: QuoteData[] = []

/** The pending quotes for one thread (referentially stable while empty). */
export const usePendingQuotes = (threadId: string): QuoteData[] =>
  usePendingQuotesStore((state) => state.quotesByThread[threadId] ?? emptyQuotes)
