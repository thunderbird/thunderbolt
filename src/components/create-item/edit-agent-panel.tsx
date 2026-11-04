/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { AgentDetail } from '@/components/settings/agents/agent-detail'
import { CloudAgentDetail, type AgentDetailView } from '@/components/settings/agents/cloud-agent-detail'
import { useCloudAgentsState } from '@/components/cloud-agent/use-cloud-agents-state'
import { useCloudAgentReadiness } from '@/components/cloud-agent/cloud-agent-access'
import { CloudError } from '@/components/cloud-agent/common'
import { useAuth, useDatabase } from '@/contexts'
import { deleteAgent, updateAgent, useAllAgents } from '@/dal'
import { useChatStore } from '@/chats/chat-store'
import { isPortableAgent } from '@/defaults/agents'

/** Reuse the settings editors over the chat without changing its route or selected agent. */
export const EditAgentPanel = ({
  agentId,
  ...surface
}: {
  agentId: string
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
}) => {
  const { t } = useLingui()
  const db = useDatabase()
  const auth = useAuth()
  const { data: session } = auth.useSession()
  const ownerId = session?.user.id ?? ''
  const signedIn = !!ownerId && !session?.user.isAnonymous
  const agents = useAllAgents({ includeCloud: false })
  const selectedAgent = agents.find((agent) => agent.id === agentId)
  const localAgent = selectedAgent && !isPortableAgent(selectedAgent) ? selectedAgent : undefined
  const needsCloud = signedIn && !localAgent
  const readiness = useCloudAgentReadiness(ownerId, needsCloud)
  const cloud = useCloudAgentsState(ownerId, { enabled: needsCloud, contentEnabled: readiness.data === true })
  const cloudAgent = cloud.agents.data?.find(({ record }) => record.id === agentId)
  const [view, setView] = useState<AgentDetailView>('settings')

  const body = () => {
    if (localAgent) {
      return (
        <AgentDetail
          agent={localAgent}
          currentUserId={ownerId || null}
          onClose={surface.onClose}
          onRemoved={surface.onClose}
          onUpdate={async (patch) => {
            const changed = await updateAgent(db, localAgent.id, patch)
            if (changed) {
              useChatStore.getState().applyAgentWireIdentityChange({ ...localAgent, ...patch })
            }
          }}
          onDelete={() => deleteAgent(db, localAgent.id)}
        />
      )
    }
    if (cloudAgent) {
      return (
        <CloudAgentDetail
          client={cloud.client}
          agent={cloudAgent}
          connections={cloud.connections.data ?? []}
          managedModel={cloud.capabilities.data?.managedModel ?? null}
          view={view}
          onViewChange={setView}
          onClose={surface.onClose}
          onSaved={() => {
            void cloud.refresh()
          }}
        />
      )
    }
    const error = readiness.error ?? cloud.capabilities.error ?? cloud.agents.error
    const loading = needsCloud && (readiness.isFetching || cloud.capabilities.isFetching || cloud.agents.isFetching)
    return (
      <DetailPanel title={t`Agent settings`} onClose={surface.onClose}>
        {error ? (
          <CloudError error={error} />
        ) : loading ? (
          <Loader2 className="size-5 animate-spin" />
        ) : (
          <p>
            <Trans>Agent not found</Trans>
          </p>
        )}
      </DetailPanel>
    )
  }

  return (
    <DetailPanelSurface {...surface} topInset>
      {body()}
    </DetailPanelSurface>
  )
}
