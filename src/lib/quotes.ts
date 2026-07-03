/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QuoteData, ThunderboltUIMessage } from '@/types'

/**
 * The AI SDK `data-*` part type for a quoted passage the user is replying to.
 * Like `data-attachment` it's UI-only — `convertToModelMessages` ignores data
 * parts — so it persists/syncs cheaply and renders as a first-class chip in the
 * composer and a blockquote in the sent bubble. {@link hydrateQuotesAsText}
 * flattens it into a `> …` text part at send time so the model sees the context.
 */
export const quotePartType = 'data-quote' as const

export type QuotePart = {
  type: typeof quotePartType
  id?: string
  data: QuoteData
}

/** Build the quote part to include in an outgoing message. */
export const buildQuotePart = (data: QuoteData): QuotePart => ({
  type: quotePartType,
  data,
})

/** Type guard for quote parts. */
export const isQuotePart = (part: { type: string }): part is QuotePart => part.type === quotePartType

/** Extract all quoted passages from a message, in order. */
export const getQuotes = (message: ThunderboltUIMessage): QuoteData[] =>
  message.parts.filter(isQuotePart).map((part) => part.data)

/** Render a quoted passage as a Markdown blockquote (every line prefixed with `> `). */
const quoteToBlockquote = (data: QuoteData): string =>
  data.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')

/**
 * Replace reference-only quote parts with a `text` part carrying the passage as
 * a Markdown blockquote, so `convertToModelMessages` forwards it to the model.
 * Mirrors `hydrateAttachmentsAsFileParts`: the persisted message keeps only the
 * structured `data-quote` part; the blockquote is materialized in-flight.
 *
 * Applies to every turn (not just the latest) — quotes are small text, so unlike
 * native attachment bytes there's no payload or replay concern in resending them.
 */
export const hydrateQuotesAsText = (messages: ThunderboltUIMessage[]): ThunderboltUIMessage[] =>
  messages.map((message) => {
    if (!message.parts.some(isQuotePart)) {
      return message
    }
    return {
      ...message,
      parts: message.parts.map((part) =>
        isQuotePart(part) ? { type: 'text' as const, text: quoteToBlockquote(part.data) } : part,
      ),
    }
  })
