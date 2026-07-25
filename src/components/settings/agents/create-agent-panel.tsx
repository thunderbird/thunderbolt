/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v7 as uuidv7 } from 'uuid'
import { useQueryClient } from '@tanstack/react-query'

import { testAcpConnection } from '@/acp'
import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { DetailPanel } from '@/components/detail-panel'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { createAgent } from '@/dal'
import { fireAndForgetSelfEnrollment, selfEnrollIrohNodeId } from '@/lib/iroh-enrollment'
import { AddCustomAgentForm, type AddCustomAgentPayload } from './add-custom-agent-form'

type CreateAgentPanelProps = {
  onClose: () => void
  /** Test/DI override for reading this app's iroh NodeId. */
  loadAppNodeId?: () => Promise<string>
  /** Test/DI override for app NodeId self-enrollment. */
  enrollIroh?: () => Promise<void>
}

/** Shared custom-agent creation controller used in settings and quick create. */
export const CreateAgentPanel = ({ onClose, loadAppNodeId, enrollIroh }: CreateAgentPanelProps) => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id ?? null
  const runEnroll = enrollIroh ?? (() => selfEnrollIrohNodeId(httpClient, loadAppNodeId ?? irohClientNodeId))

  const handleAdd = async (payload: AddCustomAgentPayload) => {
    if (!currentUserId) {
      return
    }
    await createAgent(db, {
      id: uuidv7(),
      name: payload.name,
      type: 'remote-acp',
      transport: payload.transport,
      url: payload.url,
      description: payload.description,
      enabled: 1,
      userId: currentUserId,
    })
    await queryClient.invalidateQueries({ queryKey: ['agents'] })
    if (payload.transport === 'iroh') {
      fireAndForgetSelfEnrollment(runEnroll)
    }
  }

  return (
    <DetailPanel title="Add Custom Agent" onClose={onClose}>
      <AddCustomAgentForm
        onClose={onClose}
        onSubmit={handleAdd}
        testAcpConnection={testAcpConnection}
        loadAppNodeId={loadAppNodeId}
      />
    </DetailPanel>
  )
}
