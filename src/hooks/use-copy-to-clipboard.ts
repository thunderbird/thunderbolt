/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react'
import { useTransientFlag } from './use-transient-flag'

/**
 * Hook for copying text to clipboard with a temporary "copied" feedback state.
 * Handles cleanup on unmount to avoid stale timer updates.
 * @param resetMs - How long `isCopied` stays true (default: 2000ms)
 * @returns `copy(text)` function and `isCopied` state
 */
export const useCopyToClipboard = (resetMs = 2000) => {
  const { isSet: isCopied, flag } = useTransientFlag(resetMs)

  const copy = useCallback(
    async (text: string) => {
      await navigator.clipboard.writeText(text)
      flag()
    },
    [flag],
  )

  return { copy, isCopied }
}
