/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { detectPlatform, loadRelease, parseRelease, type DownloadRelease } from './downloads'

import releaseSnapshot from '../../../data/download-release.json'

export const bundledRelease = parseRelease(releaseSnapshot)

const subscribe = () => () => {}
const getPlatform = () => detectPlatform(navigator.userAgent, navigator.maxTouchPoints)
const getServerPlatform = () => 'unknown' as const

export type ReleaseState = { status: 'loading' } | { status: 'ready'; release: DownloadRelease } | { status: 'failed' }

/** Resolve the visitor's OS after hydration and load live release assets with cancellation. */
export const useDownloadState = (initialRelease: DownloadRelease = bundledRelease) => {
  const detectedPlatform = useSyncExternalStore(subscribe, getPlatform, getServerPlatform)
  const [releaseState, setReleaseState] = useState<ReleaseState>({ status: 'ready', release: initialRelease })

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10000)
    const refresh = async () => {
      try {
        const release = await loadRelease(controller.signal)
        if (disposed) return
        setReleaseState({ status: 'ready', release })
      } catch {
        // Keep the bundled installers available when the cache cannot be refreshed.
      } finally {
        window.clearTimeout(timeout)
      }
    }
    void refresh()
    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [])

  return { detectedPlatform, releaseState }
}
