/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { v7 as uuidv7 } from 'uuid'

import { testAcpConnection } from '@/acp'
import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import { useChatStore } from '@/chats/chat-store'
import { DetailPanelSurface } from '@/components/detail-panel'
import { AddCustomAgentDialog, type AddCustomAgentPayload } from '@/components/settings/agents/add-custom-agent-dialog'
import { AgentDetail } from '@/components/settings/agents/agent-detail'
import { AgentList } from '@/components/settings/agents/agent-list'
import { ThunderboltCliDetail, ThunderboltCliRow } from '@/components/settings/agents/thunderbolt-cli'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { createAgent, deleteAgent, updateAgent, useAllAgents } from '@/dal'
import { useIsMobile } from '@/hooks/use-mobile'
import { selfEnrollIrohNodeId } from '@/lib/iroh-enrollment'

type AgentsSettingsPageProps = {
  /** Test/DI override for reading this app's iroh NodeId. Forwarded to the add
   *  dialog's pairing panel and used by the transparent same-account enrollment.
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
 * is "+" → the Add custom agent dialog.
 */
export default function AgentsSettingsPage({ loadAppNodeId, enrollIroh }: AgentsSettingsPageProps = {}) {
  const db = useDatabase()
  const agents = useAllAgents()
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id ?? null
  const allowCustomAgents = useConfigStore((state) => selectAllowCustomAgents(state.config))
  const runEnroll = enrollIroh ?? (() => selfEnrollIrohNodeId(httpClient, loadAppNodeId ?? irohClientNodeId))
  const { isMobile } = useIsMobile()

  const [dialogOpen, setDialogOpen] = useState(false)
  // The CLI install card shares the slide-in panel slot with the agent rows,
  // so the selection is a union rather than a bare agent id (a string
  // sentinel could collide with a server-chosen agent id).
  const [activePanel, setActivePanel] = useState<{ kind: 'agent'; id: string } | { kind: 'cli' } | null>(null)
  const cliOpen = activePanel?.kind === 'cli'

  // Deriving from the live list means the panel follows sync: if the active
  // agent is deleted on another device, `activeAgent` turns undefined and the
  // panel closes on its own.
  const activeAgent = activePanel?.kind === 'agent' ? agents.find((a) => a.id === activePanel.id) : undefined
  const panelOpen = activeAgent !== undefined || cliOpen

  const closePanel = () => setActivePanel(null)
  const toggleAgentPanel = (id: string) =>
    setActivePanel((current) => (current?.kind === 'agent' && current.id === id ? null : { kind: 'agent', id }))
  const toggleCliPanel = () => setActivePanel((current) => (current?.kind === 'cli' ? null : { kind: 'cli' }))

  const handleAdd = async (payload: AddCustomAgentPayload) => {
    if (!currentUserId) {
      // No session yet (auth still pending) — the "+" trigger is disabled in
      // that state, but the guard keeps the write safe.
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
    if (payload.transport !== 'iroh') {
      return
    }
    // App enrolls its own dialer NodeId; bridge registers itself server-side.
    // Fire and forget: enrollment must never block add; manual pairing remains fallback.
    void runEnroll().catch((error) => {
      console.warn('iroh transparent enrollment failed; using manual pairing fallback', error)
    })
  }

  const detailPanel = activeAgent ? (
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
  ) : cliOpen ? (
    <ThunderboltCliDetail onClose={closePanel} />
  ) : null

  return (
    <div className="relative flex h-full overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="mx-auto flex h-full w-full max-w-[760px] flex-col gap-6 overflow-y-auto p-4 md:px-5">
          <PageHeader title="Agents">
            {allowCustomAgents && (
              <Button
                variant="outline"
                size="icon"
                className="bg-card"
                aria-label="Add custom agent"
                onClick={() => setDialogOpen(true)}
                disabled={!currentUserId}
              >
                <Plus />
              </Button>
            )}
          </PageHeader>

          {/* Clicking the already-open row closes the panel — the rows carry
              aria-pressed, so they behave as the toggles they announce.
              The CLI row shares the list's row gap so it reads as one list
              (gap-4, matching the models page). */}
          <div className="flex flex-col gap-4">
            <AgentList
              agents={agents}
              selectedId={activeAgent?.id ?? null}
              onOpenAgent={(agent) => toggleAgentPanel(agent.id)}
            />

            <ThunderboltCliRow isSelected={cliOpen} onOpen={toggleCliPanel} />
          </div>
        </div>
      </div>

      <DetailPanelSurface open={panelOpen} isMobile={isMobile}>
        {detailPanel}
      </DetailPanelSurface>

      <AddCustomAgentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleAdd}
        testAcpConnection={testAcpConnection}
        loadAppNodeId={loadAppNodeId}
      />
    </div>
  )
}
