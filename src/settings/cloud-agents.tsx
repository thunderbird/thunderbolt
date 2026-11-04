/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Navigate, useSearchParams } from 'react-router'
import { legacyCloudAgentLocation } from '@/cloud-agent/navigation'

/** Existing bookmarks redirect to the unified agents, connections, or artifacts page. */
const LegacyCloudAgentsRedirect = () => {
  const [search] = useSearchParams()
  return <Navigate to={legacyCloudAgentLocation(search)} replace />
}

export default LegacyCloudAgentsRedirect
