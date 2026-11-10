/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps, MouseEvent } from 'react'
import type { InstallerId } from './downloads'

type InstallerLinkProps = ComponentProps<'a'> & {
  installerId?: InstallerId
  continueToDownloadPage?: boolean
}

export const InstallerLink = ({
  installerId,
  continueToDownloadPage = false,
  onClick,
  ...props
}: InstallerLinkProps) => {
  if (!continueToDownloadPage || !installerId) return <a {...props} onClick={onClick} />

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return

    // Let the native link start the download in its own browsing context before leaving this page.
    window.setTimeout(() => window.location.assign(`/download/?installer=${installerId}`), 0)
  }

  return <a {...props} target="_blank" rel="noopener" onClick={handleClick} />
}
