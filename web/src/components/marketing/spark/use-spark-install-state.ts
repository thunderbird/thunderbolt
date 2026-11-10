/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react'
import { cliInstallCommand, type CliPlatform } from '../../../data/website-product'

/** Tracks the selected platform and clipboard feedback for the CLI installer. */
export const useSparkInstallState = () => {
  const [platform, setPlatform] = useState<CliPlatform>('macos')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyRequest = useRef(0)

  /** Clear feedback and invalidate pending copies when the selected platform changes. */
  const selectPlatform = (next: CliPlatform) => {
    copyRequest.current += 1
    setPlatform(next)
    setCopyState('idle')
  }

  /** Copy the supported installer, with a manual fallback when clipboard access is unavailable. */
  const copyCommand = async () => {
    const request = ++copyRequest.current
    try {
      await navigator.clipboard.writeText(cliInstallCommand)
      if (request === copyRequest.current) {
        setCopyState('copied')
      }
    } catch {
      if (request === copyRequest.current) {
        setCopyState('failed')
      }
    }
  }

  return { platform, selectPlatform, copyState, copyCommand }
}
