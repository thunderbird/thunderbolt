/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useSideview } from './context'

/**
 * The open side view and the count of Try again presses, which keys the viewer's error boundary so a retry remounts
 * it and imports the viewer's code again.
 */
export const useSideviewState = () => {
  const { sideviewType, sideviewId } = useSideview()
  const [attempt, setAttempt] = useState(0)
  const retry = () => setAttempt((count) => count + 1)

  return { sideviewType, sideviewId, attempt, retry }
}
