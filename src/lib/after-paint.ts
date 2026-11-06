/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Yields to rendering when visible, or a timer when hidden; returns a cancellation handle. */
export const afterPaint = (callback: () => void): (() => void) => {
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
    }
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  const run = () => {
    cancel()
    callback()
  }
  const onVisibilityChange = () => {
    if (!document.hidden || timer !== undefined) {
      return
    }
    // Hidden tabs can suspend either animation frame indefinitely.
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
    }
    timer = setTimeout(run, 0)
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (document.hidden) {
    onVisibilityChange()
  } else {
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(run)
    })
  }
  return cancel
}

/** Warms one chunk at a time, yielding between imports. */
export const preloadInBackground = (loaders: Array<() => Promise<unknown>>): (() => void) => {
  let cancelled = false
  let cancelFrame = () => {}
  const next = (index: number) => {
    if (cancelled || index === loaders.length) {
      return
    }
    cancelFrame = afterPaint(async () => {
      try {
        await loaders[index]()
      } catch (error) {
        console.warn('[preload] Route warming failed:', error)
      }
      next(index + 1)
    })
  }
  next(0)
  return () => {
    cancelled = true
    cancelFrame()
  }
}
