/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'

import { testAcpConnection } from '@/acp'
import { selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import { useChatStore } from '@/chats/chat-store'
import { DetailPanelSurface } from '@/components/detail-panel'
import { AgentDetail } from '@/components/settings/agents/agent-detail'
import { AgentList } from '@/components/settings/agents/agent-list'
import { CreateAgentDetailPanel } from '@/components/settings/agents/create-agent-detail-panel'
import { ThunderboltCliDetail, ThunderboltCliRow } from '@/components/settings/agents/thunderbolt-cli'
import { SettingsListPane } from '@/components/settings/settings-list'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PageHeader } from '@/components/ui/page-header'
import { useAuth, useDatabase } from '@/contexts'
import { deleteAgent, updateAgent, useAllAgents } from '@/dal'

type AgentsSettingsPageProps = {
  /** Test/DI override for reading this app's iroh NodeId. Forwarded to the add
   *  form's pairing panel and used by the transparent same-account enrollment.
   *  Production omits and lazy-loads the wasm client. */
  loadAppNodeId?: () => Promise<string>
  /** Test/DI override for app NodeId self-enrollment, fired when an iroh agent is added.
   *  Production omits and binds the authenticated client. */
  enrollIroh?: () => Promise<void>
}

/**
 * Settings page listing every agent the user can chat with: the built-in
 * Thunderbolt assistant, system-provided agents synced from `/agents`
 * discovery, and user-added custom remote ACP endpoints. Rows are read-only —
 * clicking one slides in a detail panel (same slide-in idiom as the skills
 * page) where all viewing and management happens. The only other affordance
 * is "+" → the Add Custom Agent panel.
 */
const AgentsSettingsPage = ({ loadAppNodeId, enrollIroh }: AgentsSettingsPageProps = {}) => {
  const db = useDatabase()
  const agents = useAllAgents()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id ?? null
  const allowCustomAgents = useConfigStore((state) => selectAllowCustomAgents(state.config))

  // The add form, the CLI install card, and the agent rows all share the one
  // slide-in panel slot, so the selection is a single union — the panels are
  // mutually exclusive by construction (a string sentinel could collide with
  // a server-chosen agent id).
  const [activePanel, setActivePanel] = useState<
    { kind: 'add' } | { kind: 'agent'; id: string } | { kind: 'cli' } | null
  >(null)
  const cliOpen = activePanel?.kind === 'cli'
  const addOpen = activePanel?.kind === 'add'

  // Deriving from the live list means the panel follows sync: if the active
  // agent is deleted on another device, `activeAgent` turns undefined and the
  // panel closes on its own.
  const activeAgent = activePanel?.kind === 'agent' ? agents.find((a) => a.id === activePanel.id) : undefined
  const panelOpen = addOpen || activeAgent !== undefined || cliOpen

  const closePanel = () => setActivePanel(null)
  const openAddPanel = () => setActivePanel({ kind: 'add' })
  const toggleAgentPanel = (id: string) =>
    setActivePanel((current) => (current?.kind === 'agent' && current.id === id ? null : { kind: 'agent', id }))
  const toggleCliPanel = () => setActivePanel((current) => (current?.kind === 'cli' ? null : { kind: 'cli' }))

  const renderPanel = () => {
    if (addOpen) {
      return <CreateAgentDetailPanel onClose={closePanel} loadAppNodeId={loadAppNodeId} enrollIroh={enrollIroh} />
    }
    if (activeAgent) {
      return (
        <AgentDetail
          // Keyed by id so inline-edit drafts reset when switching agents.
          key={activeAgent.id}
          agent={activeAgent}
          currentUserId={currentUserId}
          onClose={closePanel}
          onRemoved={closePanel}
          onUpdate={async (patch) => {
            const wireIdentityChanged = await updateAgent(db, activeAgent.id, patch)
            if (wireIdentityChanged) {
              // Refresh any live chat sessions pointed at this agent so their next
              // send reconnects against the new endpoint (THU-695).
              useChatStore.getState().applyAgentWireIdentityChange({ ...activeAgent, ...patch })
            }
          }}
          onDelete={() => deleteAgent(db, activeAgent.id)}
          testAcpConnection={testAcpConnection}
        />
      )
    }
    if (cliOpen) {
      return <ThunderboltCliDetail onClose={closePanel} />
    }
    return null
  }

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        {/* The pane's md:min-w keeps the rows readable when the detail panel
            is open on a narrow window: the list stops shrinking and slides
            under the panel (the column's overflow-hidden clips it at the
            panel edge). */}
        <SettingsListPane className="gap-6 overflow-y-auto">
          <PageHeader title="Agents">
            {allowCustomAgents && (
              <PageCreateAction label="New Agent" onClick={openAddPanel} disabled={!currentUserId} />
            )}
          </PageHeader>

          {/* Clicking the already-open row closes the panel — the rows carry
              aria-pressed, so they behave as the toggles they announce.
              The CLI row shares the list's row gap so it reads as one list
              (gap-4, matching the models page). */}
          <div className="flex flex-col gap-4 pt-3 md:pt-0">
            <AgentList
              agents={agents}
              selectedId={activeAgent?.id ?? null}
              onOpenAgent={(agent) => toggleAgentPanel(agent.id)}
            />

            <ThunderboltCliRow isSelected={cliOpen} onOpen={toggleCliPanel} />
          </div>
        </SettingsListPane>
      </div>

      <DetailPanelSurface open={panelOpen} onClose={closePanel}>
        {renderPanel()}
      </DetailPanelSurface>
    </div>
  )
}

export default AgentsSettingsPage
