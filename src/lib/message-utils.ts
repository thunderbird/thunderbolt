/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'

type TextPart = Extract<UIMessage['parts'][number], { type: 'text' }>

/**
 * Extracts and joins all text content from a message's parts.
 * Filters to text parts only, excluding reasoning, tool calls, etc.
 */
export const extractTextFromParts = (parts: UIMessage['parts'], separator = '\n\n'): string =>
  parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) =>
      part.text
        .replace(/<widget:[^/]*\/>/g, '')
        .replace(/\[\d+\](?!\()(?:\s*\[\d+\](?!\())*/g, '')
        .trim(),
    )
    .filter(Boolean)
    .join(separator)
