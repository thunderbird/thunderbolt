/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ActiveTrustDomain } from '@/stores/trust-domain-registry'

/**
 * Filename for the SQLite file that holds the given trust domain's data.
 *
 *   { kind: 'standalone' }              → 'standalone.db'           (one per device)
 *   { kind: 'server', serverId: 'abc' } → 'server-abc.db'           (one per server)
 *
 * The architecture is N-trust-domain ready; v1 production only ever reaches the server file.
 */
export const getDbFilenameFor = (domain: ActiveTrustDomain): string => {
  if (domain.kind === 'standalone') {
    return 'standalone.db'
  }
  return `server-${domain.serverId}.db`
}
