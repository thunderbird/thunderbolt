/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const sessionHistoryLimits = {
  searchBytes: 6 * 1024,
  readBytes: 12 * 1024,
  turnBytes: 32 * 1024,
  calls: 12,
  results: 8,
  messages: 12,
} as const

const encoder = new TextEncoder()

/** Count UTF-8 bytes instead of estimating English tokens for multilingual text. */
export const utf8Bytes = (text: string): number => encoder.encode(text).length

/** Keep a valid Unicode prefix whose JSON representation fits the byte budget. */
export const clipJsonText = (text: string, maxBytes: number): string => {
  const characters = Array.from(text)
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8Bytes(JSON.stringify(characters.slice(0, middle).join(''))) <= maxBytes) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  return characters.slice(0, low).join('')
}

/** Bound concurrent tool results as well as repeated sequential retrieval in one turn. */
export const createSessionHistoryBudget = () => {
  const state = { remaining: sessionHistoryLimits.turnBytes as number, calls: 0 }
  return async (maximum: number, run: (bytes: number) => Promise<string>): Promise<string> => {
    if (state.remaining < 2048 || state.calls >= sessionHistoryLimits.calls) {
      return JSON.stringify({
        error: 'Session history budget exhausted for this turn. Answer using the evidence already retrieved.',
      })
    }
    const allowance = Math.min(maximum, state.remaining)
    state.remaining -= allowance
    state.calls += 1
    try {
      const result = await run(allowance)
      const bytes = utf8Bytes(result)
      if (bytes > allowance) {
        throw new Error('Session history result exceeded its byte budget')
      }
      state.remaining += allowance - bytes
      return result
    } catch (error) {
      state.remaining += allowance
      throw error
    }
  }
}
