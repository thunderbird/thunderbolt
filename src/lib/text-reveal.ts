/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** UTF-16 cursor and fractional time carried between animation frames. */
export type TextRevealState = { revealed: number; carryMs: number }
export const initialTextReveal: TextRevealState = { revealed: 0, carryMs: 0 }

/**
 * Advance display progress at an adaptive pace. The 250ms response constant
 * accelerates a backlog; it is not a deadline (1,000 characters take ~976ms).
 */
export const advanceTextReveal = (state: TextRevealState, targetLength: number, elapsedMs: number): TextRevealState => {
  const pending = targetLength - state.revealed
  if (pending <= 0) {
    return { revealed: targetLength, carryMs: 0 }
  }
  const interval = Math.min(5, 250 / pending)
  const budget = state.carryMs + Math.max(0, elapsedMs)
  const count = Math.min(pending, Math.floor(budget / interval))
  return {
    revealed: state.revealed + count,
    carryMs: count === pending ? 0 : budget - count * interval,
  }
}
