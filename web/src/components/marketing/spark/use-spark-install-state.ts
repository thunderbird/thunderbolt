/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { cliInstallCommand } from '../../../data/website-product'

/** Tracks clipboard feedback for the CLI installer. */
export const useSparkInstallState = () => {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  /** Copy the supported installer, with a manual fallback when clipboard access is unavailable. */
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(cliInstallCommand)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return { copyState, copyCommand }
}
