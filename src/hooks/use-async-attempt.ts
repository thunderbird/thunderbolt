/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef } from 'react'

/** A single async lane whose cancelled results cannot settle a newer attempt. */
export const createAsyncAttempt = (isActive: () => boolean = () => true) => {
  let current: symbol | null = null
  const cancel = () => {
    current = null
  }
  const begin = () => {
    if (!isActive() || current !== null) {
      return null
    }
    const token = Symbol()
    current = token
    return {
      isCurrent: () => isActive() && current === token,
      finish: () => {
        if (current === token) {
          current = null
        }
      },
    }
  }
  return { begin, cancel }
}

/** Own an async lane for one mounted UI flow; only mounted flows may publish results. */
export const useAsyncAttempt = () => {
  const mounted = useRef(true)
  const attempt = useMemo(() => createAsyncAttempt(() => mounted.current), [])
  useEffect(() => {
    mounted.current = true
    return () => {
      // Preserve the reservation across Strict Mode's synchronous effect replay,
      // while still suppressing callbacks after an actual unmount.
      mounted.current = false
    }
  }, [])
  return attempt
}
