/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSearchParams } from 'react-router'

/** Browse project artifacts without replacing the current chat or its URL state. */
export const useProjectArtifactsDialog = () => {
  const [params, setParams] = useSearchParams()
  const setProject = (projectId: string | null) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (projectId) {
          next.set('artifacts', projectId)
        } else {
          next.delete('artifacts')
        }
        return next
      },
      { replace: true },
    )
  }

  return {
    projectId: params.get('artifacts'),
    open: (projectId: string) => setProject(projectId),
    close: () => setProject(null),
  }
}
