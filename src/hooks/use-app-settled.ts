/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'

/** How long to keep artifact scripts idle after the app first shows an artifact, so the initial page/chat load can finish first. */
const appSettleDelayMs = 1000

let settled = false
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  // Start the one-shot timer the first time anything subscribes (≈ the first artifact appears).
  if (!settled && timer === null) {
    timer = setTimeout(() => {
      settled = true
      timer = null
      for (const notify of listeners) {
        notify()
      }
    }, appSettleDelayMs)
  }
  return () => {
    listeners.delete(listener)
  }
}

/**
 * One-shot signal that the app has settled after its initial load. It becomes
 * true ~1s after the first artifact appears and stays true for the rest of the
 * session — so the first artifacts hold their scripts while the page hydrates,
 * but ones shown later (after closing the side panel, or generated mid-session)
 * run immediately rather than waiting again.
 */
export const useAppSettled = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => settled,
    () => false,
  )

/** Test-only: reset the one-shot so each test starts unsettled. */
export const resetAppSettledForTests = (): void => {
  settled = false
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  listeners.clear()
}
