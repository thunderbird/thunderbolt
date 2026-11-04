/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EditAgentPanel } from './edit-agent-panel'
import { DetailPanelSurface } from '@/components/detail-panel'
import { CreateAgentDetailPanel } from '@/components/settings/agents/create-agent-detail-panel'

type CreateAgentPanelProps = {
  agentId?: string
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
}

/** Adds a custom agent over the current screen without changing routes.
 *  Thin surface wrapper only — the panel body (`CreateAgentDetailPanel`) is
 *  shared with the settings/agents route, so don't inline the form here. */
export const CreateAgentPanel = ({ agentId, ...props }: CreateAgentPanelProps) => {
  if (agentId) {
    return <EditAgentPanel agentId={agentId} {...props} />
  }
  return (
    <DetailPanelSurface {...props} topInset>
      <CreateAgentDetailPanel onClose={props.onClose} />
    </DetailPanelSurface>
  )
}
