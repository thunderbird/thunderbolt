/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { installers, releasesUrl } from './downloads'
import type { ReleaseState } from './use-download-state'

const subscribe = () => () => {}
const getServerInstaller = () => undefined

/** Accept only catalog IDs; a visit or refresh never starts a second download. */
export const getRequestedInstaller = (search: string) => {
  const id = new URLSearchParams(search).get('installer')
  return installers.find((installer) => installer.id === id)
}
const getInstaller = () => getRequestedInstaller(window.location.search)

export const DownloadArrival = ({ releaseState }: { releaseState: ReleaseState }) => {
  const installer = useSyncExternalStore(subscribe, getInstaller, getServerInstaller)
  if (!installer) return null
  const href = releaseState.status === 'ready' ? releaseState.release.downloads[installer.id] : undefined

  return (
    <div className="download-arrival" role="status">
      <span className="download-arrival-icon" aria-hidden="true">
        ↓
      </span>
      <span>Your download should start shortly.</span>
      <a href={href ?? releasesUrl}>
        {href ? 'Download again' : 'View downloads'} <span aria-hidden="true">↗</span>
      </a>
    </div>
  )
}
