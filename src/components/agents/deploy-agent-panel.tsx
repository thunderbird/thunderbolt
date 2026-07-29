/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Deploy flow panel: fetch the deployable-agent catalog, let the user pick one,
 * render its descriptor form, then deploy and persist the result as a synced
 * `managed-acp` agent — no status polling.
 *
 * The deploy call returns the (deterministic) chat endpoint immediately, so we
 * write the agent row right away and it shows up in the list. The pipeline may
 * still be spinning up on the host for a few minutes; live status badging is
 * handled separately.
 */

import { useState } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Server } from 'lucide-react'

import { deployAgent, fetchAgentCatalog } from '@/api/agent-deploy'
import { DetailPanel } from '@/components/detail-panel'
import { SelectableCard } from '@/components/ui/selectable-card'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { createAgent } from '@/dal'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AgentDescriptor, AgentSpec } from '@shared/agent-descriptors'
import { DescriptorForm } from './descriptor-form/descriptor-form'

export const DeployAgentPanel = ({ onClose }: { onClose: () => void }) => {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const authClient = useAuth()
  const queryClient = useQueryClient()
  const { data: session } = authClient.useSession()
  const userId = session?.user?.id ?? null

  const { data: catalog = [], isPending } = useQuery({
    queryKey: ['agent-catalog'],
    queryFn: () => fetchAgentCatalog(cloudUrl ?? '', httpClient),
    enabled: Boolean(cloudUrl),
  })

  const [selected, setSelected] = useState<AgentDescriptor | null>(null)
  const [isDeploying, setIsDeploying] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <DetailPanel title="Deploy agent" onClose={onClose}>
      {selected ? (
        <DescriptorForm
          descriptor={selected}
          onSubmit={handleDeploy}
          submitLabel="Deploy"
          isSubmitting={isDeploying}
          error={error}
        />
      ) : (
        <div className="space-y-2">
          {isPending && <p className="text-[length:var(--font-size-sm)] text-muted-foreground">Loading…</p>}
          {!isPending && catalog.length === 0 && (
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              No deployable agents are available.
            </p>
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
      )}
    </DetailPanel>
  )
}
