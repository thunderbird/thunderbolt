/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { parseContentParts } from '@/ai/widget-parser'
import { type AskData, groupAskSequences, messageAsksOf } from '@/widgets/ask'

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
 */
export const collectMessageAsks = (texts: string[]): MessageAsks =>
  texts.reduce<MessageAsks>(
    ({ asks, offsets }, text) => {
      const partAsks = messageAsksOf(groupAskSequences(parseContentParts(text)))
      return { asks: [...asks, ...partAsks], offsets: [...offsets, asks.length] }
    },
    { asks: [], offsets: [] },
  )
