/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import type { CloudArtifact } from '@shared/cloud-agent/contracts'
import type { ArtifactClient } from '@/artifacts/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArtifactError } from './artifact-error'

/** Grant one agent access to this artifact; every grant is separately revocable. */
export const SnapshotArtifactAccess = ({
  client,
  artifact,
  ownerId,
}: {
  client: ArtifactClient
  artifact: CloudArtifact
  ownerId: string
}) => {
  const { t } = useLingui()
  const queryClient = useQueryClient()
  const queryKey = ['artifacts', ownerId, 'grants', artifact.id]
  const agents = useQuery({
    queryKey: ['cloud-agents', ownerId, 'agents'],
    queryFn: client.agents,
    networkMode: 'always',
  })
  const grants = useQuery({
    queryKey,
    queryFn: () => client.artifactGrants(artifact.id),
    networkMode: 'always',
    retry: false,
  })
  const update = useMutation({
    mutationFn: async ({ agentId, access }: { agentId: string; access: string }) => {
      if (access === 'none') {
        await client.revokeArtifact(artifact.id, agentId)
        return
      }
      await client.grantArtifact(artifact, agentId, access === 'write')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    networkMode: 'always',
    retry: false,
  })
  return (
    <details className="rounded-xl border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        <Trans>Agent access</Trans>
      </summary>
      <p className="my-3 text-sm text-muted-foreground">
        <Trans>
          Choose which agents can use this artifact across their conversations. Access applies to its revision history.
        </Trans>
      </p>
      <ArtifactError error={grants.error ?? agents.error ?? update.error} />
      <div className="space-y-3">
        {agents.data?.map((agent) => {
          const grant = grants.data?.find(
            (entry) =>
              entry.agentId === agent.record.id && entry.keyEpoch === artifact.keyEpoch && entry.revokedAt === null,
          )
          const access = grant ? (grant.canWrite ? 'write' : 'read') : 'none'
          return (
            <div key={agent.record.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{agent.config.name}</span>
              <Select
                value={access}
                disabled={update.isPending || !grants.data}
                onValueChange={(value) => update.mutate({ agentId: agent.record.id, access: value })}
              >
                <SelectTrigger className="w-40" aria-label={t`Artifact access for ${agent.config.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    <Trans>No access</Trans>
                  </SelectItem>
                  <SelectItem value="read" disabled={!agent.record.enabled}>
                    <Trans>Read</Trans>
                  </SelectItem>
                  <SelectItem value="write" disabled={!agent.record.enabled}>
                    <Trans>Read and write</Trans>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )
        })}
      </div>
    </details>
  )
}
