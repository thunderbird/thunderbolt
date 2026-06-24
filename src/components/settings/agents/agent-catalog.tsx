/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAgentRegistry } from '@/hooks/use-agent-registry'
import { AgentCatalogView } from './agent-catalog-view'

/** Container for the bridgeable-agent catalogue: reads the live registry hook
 *  (snapshot-seeded, so always non-empty) and hands the entries to the
 *  presentational view. */
export const AgentCatalog = () => {
  const entries = useAgentRegistry()
  return <AgentCatalogView entries={entries} />
}
