/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { installers, latestReleasePage, type DownloadRelease } from './downloads'
import { useBrowserValue } from './use-browser-value'

/** The installer the address names in `?installer=`, when it is one this site offers. */
const readRequestedInstaller = () => {
  const id = new URLSearchParams(window.location.search).get('installer')
  return installers.find((installer) => installer.id === id)
}

/**
 * A way to get the installer again, shown to a visitor the homepage sent here after starting
 * a download. A reload or a shared link shows it too, so it makes no claim that one is under way.
 */
export const DownloadArrival = ({ release }: { release: DownloadRelease }) => {
  const installer = useBrowserValue(readRequestedInstaller)
  if (!installer) return null
  const href = release.downloads[installer.id]

  return (
    <div className="download-arrival" role="status">
      <span className="download-arrival-icon" aria-hidden="true">
        ↓
      </span>
      <span>Download didn’t start?</span>
      <a href={href ?? latestReleasePage}>
        {href ? 'Download again' : 'View downloads'} <span aria-hidden="true">↗</span>
      </a>
    </div>
  )
}
