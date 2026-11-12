/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useProjectExecution } from '@/agent-execution/use-project-execution'
import { SshEnvironmentStatus } from '@/components/ssh-environments'

/** Use the synced identity so unavailable profiles remain distinct from failed connections. */
export const ProjectSshStatus = ({ projectId }: { projectId: string }) => {
  const { declaration } = useProjectExecution(projectId)
  return declaration?.location === 'ssh' ? <SshEnvironmentStatus environmentId={declaration.environmentId} /> : null
}
