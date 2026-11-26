/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SearchSelection } from '@/stores/search-provider-store'

type Availability = { connection: boolean; cloud: boolean }

/** Explicit connection intent never falls back to a different account or server. */
export const resolveSearchSelection = (selection: SearchSelection, available: Availability) => {
  if (selection === 'none') {
    return null
  }
  if (selection === 'connection') {
    return available.connection ? 'connection' : null
  }
  return (selection === 'auto' || selection === 'cloud') && available.cloud ? 'cloud' : null
}
