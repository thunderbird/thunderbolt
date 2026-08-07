/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The config-aware "Add agent" panel body, shared by every surface that offers
 * adding an agent (the settings route and the chat picker's quick-create). It
 * picks the panel by deployment capability so both surfaces stay in lockstep:
 * when the managed-deploy flow is on it renders {@link AddAgentPanel} (catalog +
 * inline connect), otherwise the connect-only {@link CreateAgentDetailPanel}.
 *
 * Renders its own `DetailPanel` header, so host it inside a `DetailPanelSurface`.
 */

import { selectAgentDeploy, selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import { CreateAgentDetailPanel } from '@/components/settings/agents/create-agent-detail-panel'
import { AddAgentPanel } from './add-agent-panel'

type AddAgentBodyProps = {
  onClose: () => void
  /** Test/DI override for reading this app's iroh NodeId (connect path). */
  loadAppNodeId?: () => Promise<string>
  /** Test/DI override for app NodeId self-enrollment (connect path). */
  enrollIroh?: () => Promise<void>
}

export const AddAgentBody = ({ onClose, loadAppNodeId, enrollIroh }: AddAgentBodyProps) => {
  const agentDeploy = useConfigStore((state) => selectAgentDeploy(state.config))
  const allowCustomAgents = useConfigStore((state) => selectAllowCustomAgents(state.config))

  if (agentDeploy) {
    return (
      <AddAgentPanel
        onClose={onClose}
        allowConnect={allowCustomAgents}
        loadAppNodeId={loadAppNodeId}
        enrollIroh={enrollIroh}
      />
    )
  }
  return <CreateAgentDetailPanel onClose={onClose} loadAppNodeId={loadAppNodeId} enrollIroh={enrollIroh} />
}
