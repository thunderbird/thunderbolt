/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { detectPlatform, loadRelease, type DownloadRelease } from './downloads'
import { useBrowserValue } from './use-browser-value'

const readPlatform = () => detectPlatform(navigator.userAgent, navigator.maxTouchPoints)

/**
 * The visitor's platform, once the page has hydrated, and the release to offer them: the one
 * the page was built with until the site's current copy of the latest release arrives.
 */
export const useDownloadState = (builtRelease: DownloadRelease, load = loadRelease) => {
  const detectedPlatform = useBrowserValue(readPlatform)
  const [release, setRelease] = useState(builtRelease)

  useEffect(() => {
    const controller = new AbortController()
    const refresh = async () => {
      try {
        setRelease(await load(controller.signal))
      } catch (error) {
        if (!controller.signal.aborted) console.error('Release refresh failed; offering the built-in release', error)
      }
    }
    void refresh()
    return () => controller.abort()
  }, [load])

  return { detectedPlatform, release }
}
