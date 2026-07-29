/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { testAcpConnection } from '@/acp'
import { DetailPanel } from '@/components/detail-panel'
import { createItemTitles } from '@/components/create-item/context'
import { AddCustomAgentForm } from './add-custom-agent-form'
import { useAddCustomAgent } from './use-add-custom-agent'

type CreateAgentDetailPanelProps = {
  onClose: () => void
  /** Test/DI override for reading this app's iroh NodeId. */
  loadAppNodeId?: () => Promise<string>
  /** Test/DI override for app NodeId self-enrollment. */
  enrollIroh?: () => Promise<void>
}

/** Shared custom-agent creation controller used in settings and quick create. */
export const CreateAgentDetailPanel = ({ onClose, loadAppNodeId, enrollIroh }: CreateAgentDetailPanelProps) => {
  const handleAdd = useAddCustomAgent({ loadAppNodeId, enrollIroh })

  return (
    <DetailPanel title={createItemTitles.agent} onClose={onClose}>
      <AddCustomAgentForm
        onClose={onClose}
        onSubmit={handleAdd}
        testAcpConnection={testAcpConnection}
        loadAppNodeId={loadAppNodeId}
      />
    </DetailPanel>
  )
}
