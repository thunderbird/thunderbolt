/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Schedules optional work after a rendering opportunity; returns its cancellation handle. */
export const afterPaint = (callback: () => void): (() => void) => {
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(callback)
  })
  let secondFrame: number | undefined
  return () => {
    cancelAnimationFrame(firstFrame)
    if (secondFrame !== undefined) {
      cancelAnimationFrame(secondFrame)
    }
  }
}

/** Warms one chunk at a time, yielding a rendering opportunity between imports. */
export const preloadInBackground = (loaders: Array<() => Promise<unknown>>): (() => void) => {
  let cancelled = false
  let cancelFrame = () => {}
  const next = (index: number) => {
    if (cancelled || index === loaders.length) {
      return
    }
    cancelFrame = afterPaint(() => {
      void (async () => {
        try {
          await loaders[index]()
        } catch (error) {
          console.warn('[preload] Route warming failed:', error)
        }
        next(index + 1)
      })()
    })
  }
  next(0)
  return () => {
    cancelled = true
    cancelFrame()
  }
}
