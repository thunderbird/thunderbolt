/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isPrivateOrInternalAddress, parseIpAddress } from '@shared/ip-classification'

/** Rejects non-web/local literals sent to extraction providers; provider servers resolve and fetch the page. */
export const isPublicWebUrl = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false
  }
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return false
  }
  const host = url.hostname.replace(/\.$/, '')
  const ip = parseIpAddress(host)
  if (ip) {
    return !isPrivateOrInternalAddress(ip)
  }
  return (
    host.includes('.') &&
    !['localhost', 'local', 'internal', 'home.arpa'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  )
}

/** Discards missing or unsafe provider media URLs without discarding otherwise useful search evidence. */
export const publicWebMediaUrl = (value: string | null | undefined): string | null =>
  value && isPublicWebUrl(value) ? value : null
