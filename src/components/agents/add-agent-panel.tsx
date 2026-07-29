/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The "Add agent" panel shown when the managed-deploy flow is enabled. It lists
 * the deployable-agent catalog with "Connect custom agent" as the first entry,
 * so both paths live in one list. Picking a catalog entry renders its descriptor
 * form and deploys; picking Connect renders the custom-endpoint form inline.
 *
 * When the catalog is empty there is nothing to choose between, so the connect
 * form is shown directly (assuming custom agents are allowed).
 *
 * A deploy returns the (deterministic) chat endpoint immediately, so the agent
 * row is persisted right away and shows up in the list — the pipeline may still
 * be spinning up on the host; live status badging is handled separately.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plug, Server } from 'lucide-react'
import { useState } from 'react'
import { v7 as uuidv7 } from 'uuid'

import { testAcpConnection } from '@/acp'
import { deployAgent, fetchAgentCatalog } from '@/api/agent-deploy'
import { DetailPanel } from '@/components/detail-panel'
import { AddCustomAgentForm } from '@/components/settings/agents/add-custom-agent-form'
import { useAddCustomAgent } from '@/components/settings/agents/use-add-custom-agent'
import { SelectableCard } from '@/components/ui/selectable-card'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { createAgent } from '@/dal'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AgentDescriptor, AgentSpec } from '@shared/agent-descriptors'
import { DescriptorForm } from './descriptor-form/descriptor-form'

type AddAgentPanelProps = {
  onClose: () => void
  /** Whether the "Connect custom agent" path is offered alongside the catalog. */
  allowConnect: boolean
  /** Test/DI override for reading this app's iroh NodeId (connect path). */
  loadAppNodeId?: () => Promise<string>
  /** Test/DI override for app NodeId self-enrollment (connect path). */
  enrollIroh?: () => Promise<void>
}

export const AddAgentPanel = ({ onClose, allowConnect, loadAppNodeId, enrollIroh }: AddAgentPanelProps) => {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const authClient = useAuth()
  const queryClient = useQueryClient()
  const { data: session } = authClient.useSession()
  const userId = session?.user?.id ?? null

  const { data: catalog = [], isLoading } = useQuery({
    queryKey: ['agent-catalog'],
    queryFn: () => fetchAgentCatalog(cloudUrl ?? '', httpClient),
    enabled: Boolean(cloudUrl),
  })

  const [selected, setSelected] = useState<AgentDescriptor | null>(null)
  const [showConnect, setShowConnect] = useState(false)
  const [isDeploying, setIsDeploying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addCustomAgent = useAddCustomAgent({ loadAppNodeId, enrollIroh })

  const handleDeploy = async (spec: AgentSpec) => {
    if (!cloudUrl || !userId || !selected) {
      setError('Cannot deploy without an authenticated session.')
      return
    }
    setIsDeploying(true)
    setError(null)
    try {
      const result = await deployAgent(cloudUrl, httpClient, {
        descriptorId: selected.id,
        schemaVersion: selected.schemaVersion,
        spec,
      })
      if (!result.connection) {
        setError('Deploy did not return a connection endpoint.')
        setIsDeploying(false)
        return
      }
      const name = typeof spec.name === 'string' && spec.name.trim().length > 0 ? spec.name.trim() : selected.name
      await createAgent(db, {
        id: uuidv7(),
        name,
        type: 'managed-acp',
        transport: 'websocket',
        url: result.connection.url,
        enabled: 1,
        userId,
      })
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy failed.')
      setIsDeploying(false)
    }
  }

  // Nothing to choose between an empty catalog and Connect — go straight to the
  // connect form (when custom agents are allowed).
  const connectDirectly = !isLoading && catalog.length === 0 && allowConnect

  // Sub-steps reached from the list get a back affordance; a direct connect form
  // (empty catalog) has no list to return to, so it stays close-only.
  const onBack = selected ? () => setSelected(null) : showConnect ? () => setShowConnect(false) : undefined

  const renderBody = () => {
    if (selected) {
      return (
        <DescriptorForm
          descriptor={selected}
          onSubmit={handleDeploy}
          submitLabel="Deploy"
          isSubmitting={isDeploying}
          error={error}
        />
      )
    }
    if (showConnect || connectDirectly) {
      return (
        <AddCustomAgentForm
          onClose={onClose}
          onSubmit={addCustomAgent}
          testAcpConnection={testAcpConnection}
          loadAppNodeId={loadAppNodeId}
        />
      )
    }
    if (isLoading) {
      return <p className="text-[length:var(--font-size-sm)] text-muted-foreground">Loading…</p>
    }
    if (catalog.length === 0) {
      return (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">No deployable agents are available.</p>
      )
    }
    return (
      <div className="space-y-2">
        {allowConnect && (
          <SelectableCard
            selected={false}
            onSelect={() => setShowConnect(true)}
            icon={<Plug className="size-[var(--icon-size-default)]" />}
            title="Connect custom agent"
            description="Connect your own agent by its ACP endpoint URL."
          />
        )}
        {catalog.map((descriptor) => (
          <SelectableCard
            key={descriptor.id}
            selected={false}
            onSelect={() => setSelected(descriptor)}
            icon={<Server className="size-[var(--icon-size-default)]" />}
            title={descriptor.name}
            description={descriptor.description ?? ''}
          />
        ))}
      </div>
    )
  }

  return (
    <DetailPanel title="Add agent" onBack={onBack} onClose={onClose}>
      {renderBody()}
    </DetailPanel>
  )
}
