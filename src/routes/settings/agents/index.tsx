/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { AgentList } from '@/components/settings/agents/agent-list'
import { AgentCatalog } from '@/components/settings/agents/agent-catalog'
import { ThunderboltCliInstallCard } from '@/components/settings/agents/thunderbolt-cli-install-card'
import { AddCustomAgentDialog, type AddCustomAgentPayload } from '@/components/settings/agents/add-custom-agent-dialog'
import { testAcpConnection } from '@/acp'
import { createAgent, deleteAgent, updateAgent, useAllAgents } from '@/dal'
import { useDatabase } from '@/contexts'
import { useAuth } from '@/contexts'
import { selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import type { Agent } from '@/types/acp'

/**
 * Settings page listing every agent the user can chat with: the built-in
 * Thunderbolt assistant (always first, immutable), system-provided agents
 * synced from `/agents` discovery (read-only), and user-added custom remote
 * ACP endpoints. The composition lives in `useAllAgents` — this page is just
 * a thin orchestrator wiring DAL writes to UI events.
 */
export default function AgentsSettingsPage() {
  const db = useDatabase()
  const agents = useAllAgents()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id ?? null
  const allowCustomAgents = useConfigStore((state) => selectAllowCustomAgents(state.config))

  const [dialogOpen, setDialogOpen] = useState(false)
  // `null` ⇒ Add mode; an Agent ⇒ Edit mode. The dialog receives a `key`
  // derived from the agent id so its reducer remounts when switching targets.
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)

  const handleToggle = async (agent: Agent, enabled: boolean) => {
    if (agent.type === 'built-in') {
      // Built-in is hardcoded; the row's toggle is disabled, so this is a
      // belt-and-braces guard. No DB row exists to update.
      return
    }
    if (agent.isSystem === 1) {
      // System agents live in the local-only `agents_system` table —
      // refreshed by discovery, not user-editable.
      return
    }
    await updateAgent(db, agent.id, { enabled: enabled ? 1 : 0 })
  }

  const handleDelete = async (agent: Agent) => {
    await deleteAgent(db, agent.id)
  }

  const handleEdit = (agent: Agent) => {
    setEditingAgent(agent)
    setDialogOpen(true)
  }

  const handleSubmit = async (payload: AddCustomAgentPayload) => {
    if (editingAgent) {
      // Only customs are editable; system / built-in rows never reach this
      // path (the row hides the Edit affordance).
      await updateAgent(db, editingAgent.id, {
        name: payload.name,
        transport: payload.transport,
        url: payload.url,
        description: payload.description,
      })
      return
    }
    if (!currentUserId) {
      // Anonymous sessions can't sync custom agents — the page hides the
      // dialog trigger in that case, but the guard keeps the write safe.
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

  const handleDialogOpenChange = (next: boolean) => {
    setDialogOpen(next)
    if (!next) {
      // Drop the edit target so a follow-up "+" opens a fresh Add dialog.
      setEditingAgent(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <PageHeader title="Agents">
        {allowCustomAgents && (
          <Button
            variant="outline"
            size="icon"
            className="rounded-lg bg-card hover:bg-accent"
            aria-label="Add Custom Agent"
            onClick={() => {
              setEditingAgent(null)
              setDialogOpen(true)
            }}
            disabled={!currentUserId}
          >
            <Plus />
          </Button>
        )}
      </PageHeader>

      {/* gap-3 matches AgentList's internal row gap so the CLI card sits the
          same distance from the last agent as the agents do from each other. */}
      <div className="flex flex-col gap-3">
        <AgentList
          agents={agents}
          currentUserId={currentUserId}
          onToggle={handleToggle}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />

        <ThunderboltCliInstallCard />
      </div>

      <AgentCatalog />

      <AddCustomAgentDialog
        key={editingAgent?.id ?? 'new'}
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        onSubmit={handleSubmit}
        editingAgent={editingAgent}
        testAcpConnection={testAcpConnection}
      />
    </div>
  )
}
