/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * Follow `target` smoothly: whenever it changes, interpolate every value from
 * where it currently is over `duration` ms. Starts at `target` (no intro
 * animation) and jumps straight there under `prefers-reduced-motion`.
 */
export const useTween = (target: number[], duration = 600): number[] => {
  const [shown, setShown] = useState(target)
  const current = useRef(target)
  const key = target.join(',')

  useEffect(() => {
    const to = key.split(',').map(Number)
    const from = current.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || from.length !== to.length) {
      current.current = to
      setShown(to)
      return
    }
    const start = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min((now - start) / duration, 1)
      const eased = easeOutCubic(t)
      current.current = to.map((value, i) => from[i] + (value - from[i]) * eased)
      setShown(current.current)
      if (t < 1) {
        frame = requestAnimationFrame(step)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [key, duration])

  return shown
}
