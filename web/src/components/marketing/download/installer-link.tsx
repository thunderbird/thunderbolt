/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps, MouseEvent } from 'react'
import { productLinks } from '../../../data/website-product'
import type { InstallerId } from './downloads'

type InstallerLinkProps = ComponentProps<'a'> & {
  /** The installer the link downloads; absent when it leads somewhere else. */
  installerId?: InstallerId
  /** Take the visitor to the download page once the download has started. */
  continueToDownloadPage: boolean
}

export const InstallerLink = ({ installerId, continueToDownloadPage, ...props }: InstallerLinkProps) => {
  if (!continueToDownloadPage || !installerId) return <a {...props} />

  const continueAfterDownload = (event: MouseEvent<HTMLAnchorElement>) => {
    // A modified click opens the link the visitor's own way, so this page stays where it is.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

    // Let the native link start the download in its own browsing context before leaving this page.
    window.setTimeout(() => window.location.assign(`${productLinks.download}?installer=${installerId}`), 0)
  }

  return <a {...props} target="_blank" rel="noopener" onClick={continueAfterDownload} />
}
