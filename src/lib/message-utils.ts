/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'

type TextPart = Extract<UIMessage['parts'][number], { type: 'text' }>

/** Distinguish assistant content from an empty stream placeholder left by Stop or an error. */
export const hasAssistantContent = (message: Pick<UIMessage, 'role' | 'parts'>): boolean =>
  message.role === 'assistant' &&
  message.parts.some((part) => {
    if (part.type === 'step-start') {
      return false
    }
    if (part.type === 'text' || part.type === 'reasoning') {
      return part.text.trim().length > 0
    }
    return true
  })

/**
 * Extracts and joins all text content from a message's parts.
 * Filters to text parts only, excluding reasoning, tool calls, etc.
 */
export const extractTextFromParts = (parts: UIMessage['parts'], separator = '\n\n'): string =>
  parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) =>
      part.text
        .replace(/<widget:[a-z][a-z0-9-]*\s+(?:[^/]|\/(?!>))+\/>/gi, '')
        .replace(/\[\d+\](?!\()(?:\s*\[\d+\](?!\())*/g, '')
        .trim(),
    )
    .filter(Boolean)
    .join(separator)

/**
 * Builds a short plain-text excerpt of a message for accessible names.
 * Collapses whitespace, drops code fences, paired emphasis and code markers (`*`, `**`, `_`, `__`, backticks) and leading markdown punctuation,
 * reduces `[text](url)` links to `text`, and truncates by code point (never
 * splitting a surrogate pair), appending an ellipsis when it cut anything.
 */
export const messageExcerpt = (text: string, maxLength = 40): string => {
  const plain = text
    .replace(/```\w*/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|`)(.+?)\1/g, '$2')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[#>*\-+\s]+/, '')
  const chars = Array.from(plain)
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('').trimEnd()}…` : plain
}
