/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

/**
 * Consume a one-shot deep-link value from router state (`location.state[key]`).
 *
 * Reads the value during render and — once per distinct value — schedules
 * `onConsume(value)` via `queueMicrotask` (deferring past render to avoid
 * setState-in-render), then clears the router state with a `replace`
 * navigation so back/forward doesn't re-trigger. The consumed value is
 * tracked in a ref so StrictMode's double render can't fire the handler
 * twice; once the state clears, the ref resets so the same deep link can be
 * sent again later.
 *
 * `''` is a valid value (e.g. "open a blank create form") — only a missing
 * or non-string entry means "no link".
 */
export const useConsumeNavState = (key: string, onConsume: (value: string) => void): void => {
  const navigate = useNavigate()
  const location = useLocation()
  const consumedRef = useRef<string | null>(null)

  const state = (location.state ?? null) as Record<string, unknown> | null
  const raw = state?.[key]
  const value = typeof raw === 'string' ? raw : null

  if (value === null) {
    consumedRef.current = null
  } else if (consumedRef.current !== value) {
    consumedRef.current = value
    queueMicrotask(() => {
      onConsume(value)
      navigate(location.pathname, { replace: true, state: {} })
    })
  }
}
