/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toolCallKey } from '@/lib/stable-stringify'
import { skillTokenRegex } from '@/skills/parse-skill-tokens'

export type WebToolIntent = 'auto' | 'search' | 'research'

export const webToolCaps: Record<WebToolIntent, number> = {
  auto: 2,
  search: 12,
  research: 30,
}

export type WebToolBudgetProbe = {
  readonly isExhausted: boolean
  readonly exhaustedAttempts: number
}

export type WebToolBudget = {
  execute: (toolName: string, input: unknown, run: () => Promise<unknown>) => Promise<unknown>
  probe: WebToolBudgetProbe
  intent: WebToolIntent
}

export type BudgetExhaustedResult = {
  status: 'budget_exhausted'
  message: string
}

/** Resolve the web-tool budget intent from explicit slash-command slugs. */
export const resolveWebToolIntent = (lastUserText: string): WebToolIntent => {
  const slugs = [...lastUserText.matchAll(skillTokenRegex)].map((match) => match[1])
  if (slugs.includes('research')) {
    return 'research'
  }
  return slugs.includes('search') ? 'search' : 'auto'
}

/** Create one combined per-turn budget for search and page-fetch calls. */
export const createWebToolBudget = (intent: WebToolIntent): WebToolBudget => {
  const cap = webToolCaps[intent]
  let consumed = 0
  let exhaustedAttempts = 0
  const dedupe = new Map<string, Promise<unknown>>()

  const tryConsume = (): boolean => {
    if (consumed >= cap) {
      exhaustedAttempts++
      return false
    }
    consumed++
    return true
  }

  return {
    intent,
    execute: (toolName, input, run) => {
      const key = normalizeWebToolKey(toolName, input)
      const cached = dedupe.get(key)
      if (cached) {
        return cached
      }
      if (!tryConsume()) {
        return Promise.resolve(budgetExhaustedResult())
      }
      const result = run()
      dedupe.set(key, result)
      result.catch(() => dedupe.delete(key))
      return result
    },
    probe: {
      get isExhausted() {
        return consumed >= cap
      },
      get exhaustedAttempts() {
        return exhaustedAttempts
      },
    },
  }
}

const normalizeSearchQuery = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, ' ')

const normalizeUrl = (value: string): string => {
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed)
    const pathname = url.pathname === '/' ? '' : url.pathname
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}${url.search}${url.hash}`
  } catch {
    return trimmed
  }
}

/** Build the normalized per-turn dedupe key for a built-in web tool call. */
export const normalizeWebToolKey = (toolName: string, input: unknown): string => {
  const params = input as Record<string, unknown>
  if (toolName === 'search') {
    return toolCallKey(toolName, { ...params, query: normalizeSearchQuery(params.query as string) })
  }
  return toolCallKey(toolName, { ...params, url: normalizeUrl(params.url as string) })
}

/** Return the structured result used when a turn's web-tool budget is spent. */
export const budgetExhaustedResult = (): BudgetExhaustedResult => ({
  status: 'budget_exhausted',
  message:
    'Per-turn web tool budget reached. Answer now from the results already gathered. If coverage is insufficient, tell the user they can ask you to search more or use /research.',
})
