/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { parseContentParts } from '@/ai/widget-parser'
import { groupAskSequences, messageAsksOf } from './group'
import type { ThunderboltUIMessage } from '@/types'
import { askMessageStateOf, formatAskResponsesNote, type AskData, type AskMessageState } from './lib'

export type MessageAsks = {
  /** Every ask in the message, across all its text parts, in order. */
  asks: AskData[]
  /** For each text part, the index in `asks` of its first ask. */
  offsets: number[]
}

/**
 * Collects the asks of every text part of one assistant message. A message
 * renders one `TextPart` per text part (tool calls sit between them), so a quiz
 * split by a tool call is only complete once the asks of all parts are answered.
 * The order is what `askStorageKeys` keys the saved answers by, so the
 * chat renderer and the model's note (`src/ai/fetch.ts`) both read it from here.
 *
 * Not exported from the `@/widgets/ask` barrel: it imports the widget parser,
 * which imports the widget registry, which imports that barrel.
 */
export const collectMessageAsks = (texts: string[]): MessageAsks =>
  texts.reduce<MessageAsks>(
    ({ asks, offsets }, text) => {
      const partAsks = messageAsksOf(groupAskSequences(parseContentParts(text)))
      return { asks: [...asks, ...partAsks], offsets: [...offsets, asks.length] }
    },
    { asks: [], offsets: [] },
  )

const textsOf = (message: ThunderboltUIMessage): string[] =>
  message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))

/**
 * The state of every assistant message's asks, for the model's note
 * (`formatAskResponsesNote`): open asks come from the message text, answers from
 * its cache, which `readCache` loads. Only messages whose text carries an ask
 * tag are read, so a conversation without one costs no database reads.
 */
export const collectConversationAskStates = (
  messages: ThunderboltUIMessage[],
  readCache: ReadMessageCache,
): Promise<AskMessageState[]> =>
  Promise.all(
    messages
      .filter((message) => message.role === 'assistant' && textsOf(message).some((text) => /<widget:ask/i.test(text)))
      .map(async (message) =>
        askMessageStateOf(collectMessageAsks(textsOf(message)).asks, (await readCache(message.id)) ?? {}),
      ),
  )

/** Loads one message's cache blob, for {@link askResponsesNoteFor}. */
export type ReadMessageCache = (messageId: string) => Promise<Record<string, unknown> | null | undefined>

/**
 * The model-facing note on every ask in the conversation (see
 * `formatAskResponsesNote`), or `null` when nothing asked. Both engines add it
 * to each send's system prompt: the legacy pipeline (`src/ai/fetch.ts`) and the
 * agent harness (`src/acp/built-in-adapter.ts`).
 */
export const askResponsesNoteFor = async (
  messages: ThunderboltUIMessage[],
  readCache: ReadMessageCache,
): Promise<string | null> => formatAskResponsesNote(await collectConversationAskStates(messages, readCache))
