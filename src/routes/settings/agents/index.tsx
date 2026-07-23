/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { v7 as uuidv7 } from 'uuid'

import { testAcpConnection } from '@/acp'
import { selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import { useChatStore } from '@/chats/chat-store'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { AddCustomAgentDialog, type AddCustomAgentPayload } from '@/components/settings/agents/add-custom-agent-dialog'
import { AgentDetail } from '@/components/settings/agents/agent-detail'
import { AgentList } from '@/components/settings/agents/agent-list'
import { ThunderboltCliDetail, ThunderboltCliRow } from '@/components/settings/agents/thunderbolt-cli'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { useAuth, useDatabase } from '@/contexts'
import { createAgent, deleteAgent, updateAgent, useAllAgents } from '@/dal'
import { useIsMobile } from '@/hooks/use-mobile'

/**
 * Settings page listing every agent the user can chat with: the built-in
 * Thunderbolt assistant, system-provided agents synced from `/agents`
 * discovery, and user-added custom remote ACP endpoints. Rows are read-only —
 * clicking one slides in a detail panel (same slide-in idiom as the skills
 * page) where all viewing and management happens. The only other affordance
 * is "+" → the Add custom agent dialog.
 */
export default function AgentsSettingsPage() {
  const db = useDatabase()
  const agents = useAllAgents()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id ?? null
  const allowCustomAgents = useConfigStore((state) => selectAllowCustomAgents(state.config))
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
  // The add form shares the slide-in surface with the detail views (same
  // aside idiom as the skills create form).
  const panelOpen = dialogOpen || activeAgent !== undefined || cliOpen

  const closePanel = () => {
    setDialogOpen(false)
    setActivePanel(null)
  }
  const openAddPanel = () => {
    setActivePanel(null)
    setDialogOpen(true)
  }
  const toggleAgentPanel = (id: string) => {
    setDialogOpen(false)
    setActivePanel((current) => (current?.kind === 'agent' && current.id === id ? null : { kind: 'agent', id }))
  }
  const toggleCliPanel = () => {
    setDialogOpen(false)
    setActivePanel((current) => (current?.kind === 'cli' ? null : { kind: 'cli' }))
  }

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
  }

  const detailPanel = dialogOpen ? (
    <DetailPanel title="Add custom agent" onClose={closePanel}>
      <AddCustomAgentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleAdd}
        testAcpConnection={testAcpConnection}
      />
    </DetailPanel>
  ) : activeAgent ? (
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
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        {/* md:min-w keeps the rows readable when the detail panel is open on a
            narrow window: the list stops shrinking and slides under the panel
            (the column's overflow-hidden clips it at the panel edge) — the
            same behavior the models page gets from its cards' min-content
            width (~320px incl. padding). Desktop-only: the panel is a
            full-screen modal on mobile, and a hard floor would overflow
            sub-360px phones. */}
        <div className="mx-auto flex h-full w-full max-w-[760px] flex-col gap-6 overflow-y-auto p-4 md:min-w-[360px] md:px-5">
          <PageHeader title="Agents">
            {allowCustomAgents && (
              <Button
                variant="outline"
                size="icon"
                className="bg-card"
                aria-label="Add custom agent"
                onClick={openAddPanel}
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

      <DetailPanelSurface open={panelOpen} isMobile={isMobile} onClose={closePanel}>
        {detailPanel}
      </DetailPanelSurface>
    </div>
  )
}
