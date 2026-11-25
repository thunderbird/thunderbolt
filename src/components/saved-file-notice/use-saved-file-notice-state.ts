/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { subscribeToMobileSaves, type MobileSave } from '@/lib/download'
import { useEffect, useState } from 'react'

const noticeDurationMs = 4_000

/**
 * The latest save on a phone, shown for four seconds or until dismissed. Listens to every save made through
 * `downloadFile`.
 */
export const useSavedFileNoticeState = () => {
  const [saved, setSaved] = useState<MobileSave | null>(null)

  useEffect(() => subscribeToMobileSaves(setSaved), [])

  useEffect(() => {
    if (!saved) {
      return
    }
    const timeoutId = window.setTimeout(() => setSaved(null), noticeDurationMs)
    return () => window.clearTimeout(timeoutId)
  }, [saved])

  const dismiss = () => setSaved(null)

  return { saved, dismiss }
}
