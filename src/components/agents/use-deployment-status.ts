/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Live deploy status for a managed agent, keyed off the id derived from its
 * synced url. Status is never stored — a page refresh simply re-runs the query,
 * so it stays correct without any device-local cache. Polling self-limits: the
 * query fetches once on mount and `refetchInterval` returns false as soon as the
 * host reports a terminal status (`running`/`failed`), so only agents still
 * spinning up keep polling.
 */

import { useQuery } from '@tanstack/react-query'

import { deploymentIdForAgent, getDeploymentStatus } from '@/api/agent-deploy'
import { useHttpClient } from '@/contexts'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { Agent } from '@/types/acp'
import type { DeployStatus } from '@shared/agent-descriptors'

const pollIntervalMs = 10_000

// Only genuinely-transient states keep polling; everything the host reports as
// settled (live, slept, failed, or gone) stops the poller.
const isTerminal = (status: DeployStatus): boolean => status !== 'pending'

/** The agent's live deploy status, or null when it carries no deployment. */
export const useDeploymentStatus = (agent: Agent): DeployStatus | null => {
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const httpClient = useHttpClient()
  const deploymentId = deploymentIdForAgent(agent)

  const { data } = useQuery({
    queryKey: ['deployment-status', deploymentId],
    queryFn: () => getDeploymentStatus(cloudUrl, httpClient, deploymentId ?? ''),
    enabled: Boolean(cloudUrl && deploymentId),
    refetchInterval: (query) => (query.state.data && isTerminal(query.state.data.status) ? false : pollIntervalMs),
  })

  return data?.status ?? null
}
