/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Orchestrates a descriptor-driven deploy: kick it off, poll the host until it's
 * running (or fails), then hand the connection to `onDeployed` (which persists a
 * synced agent row). Kept dependency-injected and side-effect-free so it can be
 * unit-tested without React, timers, or a real backend.
 */

import type {
  AgentConnection,
  AgentDescriptor,
  AgentSpec,
  DeployRequest,
  DeployResponse,
  DeploymentStatusResponse,
} from '@shared/agent-descriptors'

export type RunDeployDeps = {
  deploy: (request: DeployRequest) => Promise<DeployResponse>
  pollStatus: (deploymentId: string) => Promise<DeploymentStatusResponse>
  onDeployed: (args: { name: string; connection: AgentConnection }) => Promise<void>
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  maxAttempts?: number
  /** Lets the caller abort polling (e.g. the panel closed). */
  isCancelled?: () => boolean
}

export type RunDeployResult = { ok: true } | { ok: false; error: string }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Resolve the agent's display name from the spec, falling back to the descriptor. */
const displayName = (descriptor: AgentDescriptor, spec: AgentSpec): string => {
  const name = spec.name
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : descriptor.name
}

export const runDeploy = async (
  descriptor: AgentDescriptor,
  spec: AgentSpec,
  deps: RunDeployDeps,
): Promise<RunDeployResult> => {
  const sleep = deps.sleep ?? defaultSleep
  const interval = deps.pollIntervalMs ?? 3000
  const maxAttempts = deps.maxAttempts ?? 60

  const { deploymentId } = await deps.deploy({
    descriptorId: descriptor.id,
    schemaVersion: descriptor.schemaVersion,
    spec,
  })

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (deps.isCancelled?.()) {
      return { ok: false, error: 'Deployment cancelled.' }
    }
    const current = await deps.pollStatus(deploymentId)
    if (current.status === 'running') {
      if (!current.connection) {
        return { ok: false, error: 'Agent deployed but returned no connection.' }
      }
      await deps.onDeployed({ name: displayName(descriptor, spec), connection: current.connection })
      return { ok: true }
    }
    if (current.status === 'failed') {
      return { ok: false, error: current.detail ?? 'Deployment failed.' }
    }
    await sleep(interval)
  }
  return { ok: false, error: 'Timed out waiting for the agent to deploy.' }
}
