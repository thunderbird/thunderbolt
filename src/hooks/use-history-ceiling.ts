/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useSyncExternalStore } from 'react'
import { useNavigationType, type NavigationType } from 'react-router'

/**
 * Computes the highest router history index reachable via Forward after a
 * navigation. A PUSH discards any forward entries, so the current index
 * becomes the ceiling (even when lower than the previous one); POP/REPLACE
 * move within the existing stack and only ever raise it.
 */
export const computeHistoryCeiling = (previous: number, navigationType: NavigationType, index: number): number =>
  navigationType === 'PUSH' || index > previous ? index : previous

// Highest router history index reachable via Forward this session, held in a
// module-scoped external store (not component state or a ref) because it must
// survive consumer remounts: the browser gives no direct "can go forward"
// signal, so we track the furthest index react-router has visited.
// `window.history.length` is NOT usable here — it counts entries from before
// the router initialized (e.g. an OAuth redirect chain), which would enable
// Forward with no in-app forward entry.
let historyCeiling = 0
const historyCeilingListeners = new Set<() => void>()

/** Subscribes to history-ceiling changes; returns an unsubscribe function. */
export const subscribeToHistoryCeiling = (listener: () => void): (() => void) => {
  historyCeilingListeners.add(listener)
  return () => {
    historyCeilingListeners.delete(listener)
  }
}

/** Current Forward ceiling snapshot for `useSyncExternalStore`. */
export const getHistoryCeiling = (): number => historyCeiling

/**
 * Applies a navigation to the ceiling store and notifies subscribers when the
 * value changes (a PUSH to a lower index *lowers* it — forward entries are
 * gone). Must be called outside render (e.g. from an effect) —
 * StrictMode/concurrent React can execute-and-discard render bodies, so
 * mutating module state during render would corrupt the ceiling.
 */
export const trackHistoryCeiling = (navigationType: NavigationType, index: number): void => {
  const next = computeHistoryCeiling(historyCeiling, navigationType, index)
  if (next === historyCeiling) {
    return
  }
  historyCeiling = next
  for (const notify of historyCeilingListeners) {
    notify()
  }
}

/** Test-only: restores the pristine module state between tests. */
export const resetHistoryCeilingForTests = (): void => {
  historyCeiling = 0
  historyCeilingListeners.clear()
}

/**
 * Tracks the router's Forward ceiling and returns `{ index, ceiling }` for
 * the current location: `index > 0` means Back is possible, `index < ceiling`
 * means Forward is. Callers must also subscribe to location changes (e.g.
 * `useLocation()`) so `index` re-reads after each navigation.
 */
export const useHistoryCeiling = (): { index: number; ceiling: number } => {
  const navigationType = useNavigationType()
  const ceiling = useSyncExternalStore(subscribeToHistoryCeiling, getHistoryCeiling)

  const index = (window.history.state as { idx?: number } | null)?.idx ?? 0
  // External-system sync: push the navigation into the ceiling store after
  // commit; the store notifies and `useSyncExternalStore` re-renders with the
  // updated ceiling.
  useEffect(() => {
    trackHistoryCeiling(navigationType, index)
  }, [navigationType, index])

  return { index, ceiling }
}
