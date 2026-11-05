/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SearchSelection } from '@/stores/search-provider-store'

type Availability = {
  custom: boolean
  tinfoil: boolean
  tinfoilConfigured?: boolean
  otari?: boolean
  otariConfigured?: boolean
  cloud: boolean
}

/** Resolves the same exclusive provider for Settings and tool execution; explicit choices never silently fall back. */
export const resolveSearchSelection = (selection: SearchSelection, available: Availability) => {
  if (selection === 'none') {
    return null
  }
  if (selection !== 'auto') {
    return available[selection] ? selection : null
  }
  if (available.custom) {
    return 'custom'
  }
  if (available.tinfoil) {
    return 'tinfoil'
  }
  // A disconnected provider is not permission to send the next query to another server.
  if (available.tinfoilConfigured) {
    return null
  }
  if (available.otari) {
    return 'otari'
  }
  if (available.otariConfigured) {
    return null
  }
  if (available.cloud) {
    return 'cloud'
  }
  return null
}
