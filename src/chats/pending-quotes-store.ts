/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QuoteData } from '@/types'
import { create } from 'zustand'

/**
 * A pending quote plus a stable UI-only id. The id (not the array index) keys the
 * composer chips, so removing a middle chip doesn't reconcile survivors onto the
 * wrong DOM nodes. It's transient composer state and never serialized — only the
 * inner {@link QuoteData} is sent, so the id stays out of the persisted type.
 */
export type PendingQuote = {
  id: string
  data: QuoteData
}

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
  quotesByThread: Record<string, PendingQuote[]>
  addQuote: (threadId: string, quote: QuoteData) => void
  removeQuote: (threadId: string, id: string) => void
  setQuotes: (threadId: string, quotes: QuoteData[]) => void
  clearQuotes: (threadId: string) => void
}

export const usePendingQuotesStore = create<PendingQuotesStore>((set) => ({
  quotesByThread: {},
  addQuote: (threadId, quote) =>
    set((state) => ({
      quotesByThread: {
        ...state.quotesByThread,
        [threadId]: [...(state.quotesByThread[threadId] ?? []), { id: crypto.randomUUID(), data: quote }],
      },
    })),
  removeQuote: (threadId, id) =>
    set((state) => ({
      quotesByThread: {
        ...state.quotesByThread,
        [threadId]: (state.quotesByThread[threadId] ?? []).filter((quote) => quote.id !== id),
      },
    })),
  setQuotes: (threadId, quotes) =>
    set((state) => ({
      quotesByThread: {
        ...state.quotesByThread,
        [threadId]: quotes.map((data) => ({ id: crypto.randomUUID(), data })),
      },
    })),
  clearQuotes: (threadId) =>
    set((state) => {
      const next = { ...state.quotesByThread }
      delete next[threadId]
      return { quotesByThread: next }
    }),
}))

/** Stable empty reference so threads with no quotes don't churn selector snapshots. */
const emptyQuotes: PendingQuote[] = []

/** The pending quotes for one thread (referentially stable while empty). */
export const usePendingQuotes = (threadId: string): PendingQuote[] =>
  usePendingQuotesStore((state) => state.quotesByThread[threadId] ?? emptyQuotes)
