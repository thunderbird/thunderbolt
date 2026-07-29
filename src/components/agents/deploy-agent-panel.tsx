/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Deploy flow panel: fetch the deployable-agent catalog, let the user pick one,
 * render its descriptor form, then deploy → poll → persist a synced agent row.
 * The resulting `managed-acp` agent shows up in the normal agent list and chats
 * over the existing ACP runtime.
 */

import { useState } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Server } from 'lucide-react'

import { deployAgent, fetchAgentCatalog, getDeploymentStatus } from '@/api/agent-deploy'
import { DetailPanel } from '@/components/detail-panel'
import { SelectableCard } from '@/components/ui/selectable-card'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { createAgent } from '@/dal'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AgentDescriptor, AgentSpec } from '@shared/agent-descriptors'
import { DescriptorForm } from './descriptor-form/descriptor-form'
import { runDeploy } from './deploy-agent'

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
    const result = await runDeploy(selected, spec, {
      deploy: (request) => deployAgent(cloudUrl, httpClient, request),
      pollStatus: (deploymentId) => getDeploymentStatus(cloudUrl, httpClient, deploymentId),
      onDeployed: ({ name, connection }) =>
        createAgent(db, {
          id: uuidv7(),
          name,
          type: 'managed-acp',
          transport: 'websocket',
          url: connection.url,
          enabled: 1,
          userId,
        }),
    })
    setIsDeploying(false)
    if (result.ok) {
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      onClose()
      return
    }
    setError(result.error)
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
