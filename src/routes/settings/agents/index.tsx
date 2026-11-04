/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import type { Agent } from '@/types/acp'
import { Navigate, useLocation, useSearchParams } from 'react-router'

import { testAcpConnection } from '@/acp'
import { isCloudAgent } from '@/defaults/agents'
import { selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import { useChatStore } from '@/chats/chat-store'
import { DetailPanelSurface } from '@/components/detail-panel'
import { AgentDetail } from '@/components/settings/agents/agent-detail'
import { AgentList } from '@/components/settings/agents/agent-list'
import { CreateAgentDetailPanel } from '@/components/settings/agents/create-agent-detail-panel'
import { ThunderboltCliDetail, ThunderboltCliRow } from '@/components/settings/agents/thunderbolt-cli'
import { SettingsListBody, settingsListBodyRowsClass, SettingsListPane } from '@/components/settings/settings-list'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PageHeader } from '@/components/ui/page-header'
import { useAuth, useDatabase } from '@/contexts'
import { deleteAgent, updateAgent, useAllAgents } from '@/dal'
import { useCloudAgentsState } from '@/components/cloud-agent/use-cloud-agents-state'
import { useCloudAgentReadiness } from '@/components/cloud-agent/cloud-agent-access'
import { CloudAgentDetail } from '@/components/settings/agents/cloud-agent-detail'
import { CloudError } from '@/components/cloud-agent/common'
import { CloudOutbox } from '@/components/cloud-agent/outbox'
import {
  agentActionPanel,
  agentConversationRedirect,
  agentPageState,
  agentPanelSearch,
  type AgentPanel,
} from './page-state'

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
 * discovery, portable agents, and custom remote ACP endpoints. Rows expose
 * activation separately from the slide-in configuration panel.
 */
const AgentsSettingsPage = ({ loadAppNodeId, enrollIroh }: AgentsSettingsPageProps = {}) => {
  const { t } = useLingui()
  const db = useDatabase()
  const agents = useAllAgents({ includeCloud: false })
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id ?? null
  const signedIn = !!currentUserId && !session?.user.isAnonymous
  const readiness = useCloudAgentReadiness(currentUserId ?? '', signedIn)
  const cloud = useCloudAgentsState(currentUserId ?? '', { enabled: signedIn, contentEnabled: readiness.data === true })
  const allowCustomAgents = useConfigStore((state) => selectAllowCustomAgents(state.config))
  const toggle = useMutation({
    mutationFn: async (change: { agent: Agent; enabled: boolean } | { cloudId: string; enabled: boolean }) => {
      if ('agent' in change) {
        await updateAgent(db, change.agent.id, { enabled: change.enabled ? 1 : 0 })
        return
      }
      const agent = cloud.agents.data?.find(({ record }) => record.id === change.cloudId)
      if (!agent) {
        throw new Error(t`Agent not found`)
      }
      await cloud.client.saveAgent(agent.config, agent.record, change.enabled)
      await cloud.refresh()
    },
  })

  // The add form, the CLI install card, and the agent rows all share the one
  // slide-in panel slot, so the selection is a single union — the panels are
  // mutually exclusive by construction (a string sentinel could collide with
  // a server-chosen agent id).
  const [search, setSearch] = useSearchParams()
  const location = useLocation()
  const { panel: activePanel, view } = agentPageState(search)
  const setActivePanel = (panel: AgentPanel) => setSearch(agentPanelSearch(panel))
  const cliOpen = activePanel?.kind === 'cli'
  const addOpen = activePanel?.kind === 'add'

  // Deriving from the live list means the panel follows sync: if the active
  // agent is deleted on another device, `activeAgent` turns undefined and the
  // panel closes on its own.
  const selectedLocalAgent = activePanel?.kind === 'agent' ? agents.find((a) => a.id === activePanel.id) : undefined
  const activeAgent = selectedLocalAgent && !isCloudAgent(selectedLocalAgent) ? selectedLocalAgent : undefined
  const activeCloudAgent =
    activePanel?.kind === 'agent' ? cloud.agents.data?.find(({ record }) => record.id === activePanel.id) : undefined
  const panelOpen = addOpen || activeAgent !== undefined || activeCloudAgent !== undefined || cliOpen

  const closePanel = () => setActivePanel(null)
  const openAddPanel = () => setActivePanel({ kind: 'add' })
  const openAgentPanel = (id: string) => setActivePanel({ kind: 'agent', id })
  const toggleAgentPanel = (id: string) =>
    setActivePanel(activePanel?.kind === 'agent' && activePanel.id === id ? null : { kind: 'agent', id })
  const toggleCliPanel = () => setActivePanel(cliOpen ? null : { kind: 'cli' })

  // Palette (Cmd+K) create/edit intents arrive as one-shot router state and
  // route into the page's existing handlers (THU-768). "Edit" opens the
  // agent's detail panel — the same read-only-or-editable surface a row click
  // opens — so built-in/system agents (and ids no longer present) degrade to a
  // read-only view or no-op rather than forcing an edit. There is no inline
  // remove: deletion stays behind the detail panel's ownership-gated ⋯ menu.
  const actionPanel = agentActionPanel(location.state)

  const renderPanel = () => {
    if (addOpen) {
      return (
        <CreateAgentDetailPanel
          onClose={closePanel}
          loadAppNodeId={loadAppNodeId}
          enrollIroh={enrollIroh}
          onCloudSaved={(agent) => {
            void cloud.refresh()
            openAgentPanel(agent.record.id)
          }}
        />
      )
    }
    if (activeCloudAgent) {
      return (
        <CloudAgentDetail
          client={cloud.client}
          agent={activeCloudAgent}
          connections={cloud.connections.data ?? []}
          managedModel={cloud.capabilities.data?.managedModel ?? null}
          view={view}
          onViewChange={(nextView) => {
            const next = agentPanelSearch(activePanel)
            next.set('view', nextView)
            setSearch(next)
          }}
          onClose={closePanel}
          onSaved={() => {
            void cloud.refresh()
          }}
        />
      )
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

  const conversationRedirect = agentConversationRedirect(search)
  if (conversationRedirect) {
    return <Navigate to={conversationRedirect} replace />
  }

  if (actionPanel !== undefined) {
    return (
      <Navigate
        to={{ pathname: location.pathname, search: `?${agentPanelSearch(actionPanel)}` }}
        replace
        state={null}
      />
    )
  }

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        {/* The pane's md:min-w keeps the rows readable when the detail panel
            is open on a narrow window: the list stops shrinking and slides
            under the panel (the column's overflow-hidden clips it at the
            panel edge). */}
        <SettingsListPane className="gap-6">
          <PageHeader title={t`Agents`}>
            {allowCustomAgents && (
              <PageCreateAction label={t`New Agent`} onClick={openAddPanel} disabled={!currentUserId} />
            )}
          </PageHeader>

          {/* Clicking the already-open row closes the panel — the rows carry
              aria-pressed, so they behave as the toggles they announce.
              The CLI row shares the list's row gap so it reads as one list
              (gap-4, matching the models page). */}
          <SettingsListBody className={settingsListBodyRowsClass}>
            <AgentList
              agents={agents}
              cloudAgents={signedIn && readiness.data ? (cloud.agents.data ?? []) : []}
              selectedId={activeAgent?.id ?? activeCloudAgent?.record.id ?? null}
              onOpenAgent={(agent) => toggleAgentPanel(agent.id)}
              onOpenCloudAgent={toggleAgentPanel}
              currentUserId={currentUserId}
              onToggleAgent={(agent, enabled) => toggle.mutate({ agent, enabled })}
              onToggleCloudAgent={(cloudId, enabled) => toggle.mutate({ cloudId, enabled })}
              togglePending={toggle.isPending}
            />
            <CloudError error={toggle.error} />

            {signedIn && readiness.data && (
              <>
                <CloudError error={cloud.agents.error} />
                <CloudOutbox client={cloud.client} entries={cloud.outbox.data ?? []} refresh={cloud.refresh} />
              </>
            )}

            <ThunderboltCliRow isSelected={cliOpen} onOpen={toggleCliPanel} />
          </SettingsListBody>
        </SettingsListPane>
      </div>

      <DetailPanelSurface open={panelOpen} onClose={closePanel}>
        {renderPanel()}
      </DetailPanelSurface>
    </div>
  )
}

export default AgentsSettingsPage
