/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const maxRequestsPerTurn = 6
export const maxTurnWallClockMs = 120_000

/** The one sentinel both consuming layers throw on denial — classified by name. */
export const createTurnBudgetExhaustedError = (): Error =>
  Object.assign(new Error('Turn request budget exhausted'), { name: 'TurnBudgetExhaustedError' })

export type TurnBudgetConsumer = {
  tryConsumeRequest: () => boolean
}

export type TurnBudgetProbe = {
  readonly isExhausted: boolean
}

export type TurnBudget = {
  consumer: TurnBudgetConsumer
  probe: TurnBudgetProbe
}

/**
 * Create one turn budget.
 *
 * Invariant: every model request in a turn — first send, SDK-level retry,
 * empty-response retry, or outer auto-retry — draws from this shared budget.
 */
export const createTurnBudget = (now: () => number = Date.now): TurnBudget => {
  const startedAt = now()
  let requestsConsumed = 0
  const isExhausted = () => requestsConsumed >= maxRequestsPerTurn || now() - startedAt >= maxTurnWallClockMs

  return {
    consumer: {
      tryConsumeRequest: () => {
        if (isExhausted()) {
          return false
        }
        requestsConsumed++
        return true
      },
    },
    probe: {
      get isExhausted() {
        return isExhausted()
      },
    },
  }
}
