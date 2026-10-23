/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Navigate, useParams } from 'react-router'
import { selectMinimalMode, useConfigStore } from '@/api/config-store'

/** Existing project links now start a chat in the sidebar's project. */
export const ProjectRedirect = () => {
  const { projectId } = useParams()
  const minimalMode = useConfigStore((state) => selectMinimalMode(state.config))
  const target = projectId && !minimalMode ? `/chats/new?${new URLSearchParams({ projectId })}` : '/chats/new'
  return <Navigate replace to={target} />
}
