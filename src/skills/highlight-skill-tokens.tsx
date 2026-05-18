/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const typingTokenRegex = /\/[\w-]+(?=\s)/g
const savedTokenRegex = /\/[\w-]+(?=\s|$)/g

export const renderHighlightedSkillTokens = (
  value: string,
  isValidSkill: (token: string) => boolean,
  options: { saved?: boolean } = {},
): ReactNode[] => {
  const regex = options.saved ? savedTokenRegex : typingTokenRegex
  const parts: ReactNode[] = []
  let lastIndex = 0
  let key = 0
  for (const match of value.matchAll(regex)) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      parts.push(value.slice(lastIndex, start))
    }
    const token = match[0]
    if (isValidSkill(token)) {
      parts.push(
        <span key={key++} className="text-blue-400">
          {token}
        </span>,
      )
    } else if (options.saved) {
      parts.push(
        <Tooltip key={key++}>
          <TooltipTrigger asChild>
            <span className="text-orange-400">{token}</span>
          </TooltipTrigger>
          <TooltipContent>No skill by this name is found</TooltipContent>
        </Tooltip>,
      )
    } else {
      parts.push(token)
    }
    lastIndex = start + token.length
  }
  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex))
  }
  // Zero-width space preserves a trailing line break (matches the textarea's reserved blank line).
  parts.push('​')
  return parts
}

export const findBrokenSkillRefs = (value: string, isValidSkill: (token: string) => boolean): string[] => {
  const seen = new Set<string>()
  for (const match of value.matchAll(savedTokenRegex)) {
    const token = match[0]
    if (!isValidSkill(token)) {
      seen.add(token)
    }
  }
  return [...seen]
}
