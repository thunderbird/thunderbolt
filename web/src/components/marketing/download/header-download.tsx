/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import snapshot from '../../../data/download-release.json'
import { productLinks } from '../../../data/website-product'
import { desktopPlatforms, parseRelease } from './downloads'
import { InstallerLink } from './installer-link'
import { useDownloadState } from './use-download-state'

const fallbackRelease = parseRelease(snapshot)

export const HeaderDownload = () => {
  const { detectedPlatform, release } = useDownloadState(fallbackRelease)
  const platform = desktopPlatforms.find(({ id }) => id === detectedPlatform)
  const installer = platform?.installers[0]
  const href = installer && release.downloads[installer.id]

  return (
    <InstallerLink
      className="spark-nav-cta"
      href={href ?? productLinks.download}
      installerId={href ? installer?.id : undefined}
      continueToDownloadPage
      aria-label={href ? `Download Thunderbolt for ${platform?.name}` : 'Download Thunderbolt'}
    >
      Download <span aria-hidden="true">↓</span>
    </InstallerLink>
  )
}
