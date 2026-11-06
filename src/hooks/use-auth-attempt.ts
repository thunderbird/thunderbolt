/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'
import { useAsyncAttempt } from './use-async-attempt'

/**
 * Cancel pending credentials work, while allowing accepted sign-ins to finish after navigation.
 * Failed completion releases admission for retry; successful authentication stays terminal.
 */
export const useAuthAttempt = () => {
  const operation = useAsyncAttempt()
  const request = useRef<{ controller: AbortController; committed: boolean } | null>(null)
  useEffect(
    () => () => {
      if (!request.current?.committed) {
        request.current?.controller.abort()
      }
    },
    [],
  )

  const begin = () => {
    if (request.current?.committed) {
      return null
    }
    const attempt = operation.begin()
    if (!attempt) {
      return null
    }
    const current = { controller: new AbortController(), committed: false }
    request.current = current
    return {
      ...attempt,
      signal: current.controller.signal,
      commit: () => {
        current.committed = true
      },
      isCommitted: () => current.committed,
      isCancellation: (error: unknown) =>
        !current.committed &&
        current.controller.signal.aborted &&
        (error === current.controller.signal.reason || (error instanceof Error && error.name === 'AbortError')),
      finish: (outcome: 'succeeded' | 'failed' = 'succeeded') => {
        attempt.finish()
        if (request.current === current && (!current.committed || outcome === 'failed')) {
          request.current = null
        }
      },
    }
  }

  const cancel = () => {
    if (request.current?.committed) {
      return false
    }
    request.current?.controller.abort()
    request.current = null
    operation.cancel()
    return true
  }

  return { begin, cancel }
}
