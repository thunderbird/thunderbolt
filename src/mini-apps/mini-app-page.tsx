/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Navigate, useParams, useLocation } from 'react-router'
import { artifactId, artifactPath } from '@/artifacts/artifact'

/** Existing app bookmarks now open the shared artifact workspace. */
const MiniAppPage = () => {
  const { appId } = useParams()
  const { search, state } = useLocation()
  if (!appId) {
    return <Navigate to="/not-found" replace />
  }
  return <Navigate to={`${artifactPath(artifactId({ kind: 'remote', appId }))}${search}`} state={state} replace />
}
export default MiniAppPage
