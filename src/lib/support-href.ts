/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hasProtocol } from '@shared/url'

/**
 * The support destination to open. A mailto: address gets `prefill` added as
 * mailto fields, except any the operator's address already sets (field names
 * compare case-insensitively); a support page opens as-is.
 *
 * @param support - A validated http(s) URL or mailto: address.
 * @param prefill - Already URI-encoded values keyed by mailto field (`subject`, `body`).
 */
export const supportHref = (support: string, prefill: Record<string, string>): string => {
  if (!hasProtocol(support, 'mailto:')) {
    return support
  }
  const presetFields = new Set([...new URL(support).searchParams.keys()].map((field) => field.toLowerCase()))
  const fields = Object.entries(prefill)
    .filter(([field]) => !presetFields.has(field))
    .map(([field, value]) => `${field}=${value}`)
  if (fields.length === 0) {
    return support
  }
  const separator = support.includes('?') ? '&' : '?'
  return `${support}${separator}${fields.join('&')}`
}
