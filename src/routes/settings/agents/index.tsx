/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { Navigate } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { AgentList } from '@/components/settings/agents/agent-list'
import { AddCustomAgentDialog, type AddCustomAgentPayload } from '@/components/settings/agents/add-custom-agent-dialog'
import { testAcpConnection } from '@/acp'
import { createAgent, deleteAgent, updateAgent, useAllAgents } from '@/dal'
import { useDatabase } from '@/contexts'
import { useAuth } from '@/contexts'
import { selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import { useAgentsSettingsHidden } from '@/hooks/use-agents-settings-hidden'
import type { Agent } from '@/types/acp'

type AgentsSettingsPageProps = {
  /** Test seam — production omits; the hidden-check hook falls back to
   *  `isTauri()`. Lets tests exercise Tauri Standalone vs. Hosted code paths
   *  without mocking the shared `@/lib/platform` module (which would leak
   *  across files — see `docs/development/testing.md`). */
  isStandalone?: () => boolean
}

/**
 * Settings page listing every agent the user can chat with: the built-in
 * Thunderbolt assistant (always first, immutable), system-provided agents
 * synced from `/agents` discovery (read-only), and user-added custom remote
 * ACP endpoints. The composition lives in `useAllAgents` — this page is just
 * a thin orchestrator wiring DAL writes to UI events.
 */
export default function AgentsSettingsPage({ isStandalone }: AgentsSettingsPageProps = {}) {
  const db = useDatabase()
  const agents = useAllAgents()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id ?? null
  const agentsHidden = useAgentsSettingsHidden({ isStandalone })
  const allowCustomAgents = useConfigStore((state) => selectAllowCustomAgents(state.config))

  const [dialogOpen, setDialogOpen] = useState(false)

  // Defence against direct URL / bookmark when the entry is hidden in the
  // sidebar. Anonymous users behind the proxy can't reach managed agents, so
  // sending them back to the settings index keeps the UI honest.
  if (agentsHidden) {
    return <Navigate to="/settings" replace />
  }

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

  const handleSubmit = async (payload: AddCustomAgentPayload) => {
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

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <PageHeader title="Agents">
        {allowCustomAgents && (
          <Button
            variant="outline"
            size="icon"
            className="rounded-lg"
            aria-label="Add Custom Agent"
            onClick={() => setDialogOpen(true)}
            disabled={!currentUserId}
          >
            <Plus />
          </Button>
        )}
      </PageHeader>

      <AgentList agents={agents} currentUserId={currentUserId} onToggle={handleToggle} onDelete={handleDelete} />

      <AddCustomAgentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleSubmit}
        testAcpConnection={testAcpConnection}
      />
    </div>
  )
}
