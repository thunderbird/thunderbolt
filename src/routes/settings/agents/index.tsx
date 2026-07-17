/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AnimatePresence, m } from 'framer-motion'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { v7 as uuidv7 } from 'uuid'

import { testAcpConnection } from '@/acp'
import { selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import { AddCustomAgentDialog, type AddCustomAgentPayload } from '@/components/settings/agents/add-custom-agent-dialog'
import { AgentDetail } from '@/components/settings/agents/agent-detail'
import { AgentList } from '@/components/settings/agents/agent-list'
import { ThunderboltCliDetail, ThunderboltCliRow } from '@/components/settings/agents/thunderbolt-cli-install-card'
import { SlideInPanel } from '@/components/slide-in-panel'
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
 * is "+" → the Add Custom Agent dialog.
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
  // Either an agent id or the 'cli' sentinel — the CLI row shares the same
  // slide-in panel slot as the agent rows.
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  const cliOpen = activeAgentId === 'cli'

  // Deriving from the live list means the panel follows sync: if the active
  // agent is deleted on another device, `active` turns undefined and the
  // panel closes on its own.
  const active = agents.find((a) => a.id === activeAgentId)
  const panelOpen = active !== undefined || cliOpen

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

  const detailPanel = active ? (
    <AgentDetail
      // Keyed by id so inline-edit drafts reset when switching agents.
      key={active.id}
      agent={active}
      currentUserId={currentUserId}
      onClose={() => setActiveAgentId(null)}
      onRemoved={() => setActiveAgentId(null)}
      onUpdate={(patch) => updateAgent(db, active.id, patch)}
      onDelete={() => deleteAgent(db, active.id)}
      testAcpConnection={testAcpConnection}
    />
  ) : cliOpen ? (
    <ThunderboltCliDetail onClose={() => setActiveAgentId(null)} />
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
                aria-label="Add Custom Agent"
                onClick={() => setDialogOpen(true)}
                disabled={!currentUserId}
              >
                <Plus />
              </Button>
            )}
          </PageHeader>

          {/* Clicking the already-open row closes the panel — the rows carry
              aria-pressed, so they behave as the toggles they announce. */}
          <AgentList
            agents={agents}
            selectedId={active?.id ?? null}
            onOpenAgent={(agent) => setActiveAgentId((current) => (current === agent.id ? null : agent.id))}
          />

          <ThunderboltCliRow
            selected={cliOpen}
            onOpen={() => setActiveAgentId((current) => (current === 'cli' ? null : 'cli'))}
          />
        </div>
      </div>

      {/* ~50/50 split with the list: half the viewport minus half the sidebar —
          the same surface card as the skills detail panel. */}
      {!isMobile && (
        <SlideInPanel open={panelOpen} width="clamp(400px, calc(50vw - 128px), 800px)">
          <div className="h-full pb-4">
            <div className="h-full overflow-hidden rounded-l-2xl border border-r-0 border-border/60 bg-sidebar shadow-glow">
              {detailPanel}
            </div>
          </div>
        </SlideInPanel>
      )}
      {isMobile && (
        <AnimatePresence>
          {panelOpen && (
            <m.div
              key="mobile-agent-panel"
              className="absolute inset-0 z-10 flex bg-background"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 35, stiffness: 400, mass: 0.8 }}
            >
              {detailPanel}
            </m.div>
          )}
        </AnimatePresence>
      )}

      <AddCustomAgentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleAdd}
        testAcpConnection={testAcpConnection}
      />
    </div>
  )
}
