/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { productLinks } from '../../../data/website-product'
import { desktopPlatforms } from './downloads'
import { InstallerLink } from './installer-link'
import type { useDownloadState } from './use-download-state'

export const HeaderDownload = ({ detectedPlatform, release }: ReturnType<typeof useDownloadState>) => {
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
