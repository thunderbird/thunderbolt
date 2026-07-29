/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type {
  AgentConnection,
  AgentDescriptor,
  DeployRequest,
  DeploymentStatusResponse,
} from '@shared/agent-descriptors'
import { runDeploy, type RunDeployDeps } from './deploy-agent'

/** Typed mock factories so `.mock.calls[0][0]` is inferred. */
const mockOnDeployed = () => mock((_args: { name: string; connection: AgentConnection }) => Promise.resolve())
const mockDeploy = () =>
  mock((_request: DeployRequest) => Promise.resolve({ deploymentId: 'haystack:tb-x', status: 'pending' as const }))

const descriptor: AgentDescriptor = {
  id: 'haystack',
  provider: 'haystack',
  name: 'Haystack',
  description: null,
  icon: null,
  schemaVersion: 2,
  action: 'deploy',
  steps: [{ id: 's', title: 'S', fields: [{ key: 'name', label: 'Name', widget: 'text' }] }],
}

const running = (url: string): DeploymentStatusResponse => ({
  deploymentId: 'haystack:tb-x',
  status: 'running',
  connection: { url, transport: 'websocket' },
})
const pending: DeploymentStatusResponse = { deploymentId: 'haystack:tb-x', status: 'pending', connection: null }

const baseDeps = (over: Partial<RunDeployDeps> = {}): RunDeployDeps => ({
  deploy: () => Promise.resolve({ deploymentId: 'haystack:tb-x', status: 'pending' }),
  pollStatus: () => Promise.resolve(running('wss://h/ws?pipeline=tb-x')),
  onDeployed: () => Promise.resolve(),
  sleep: () => Promise.resolve(),
  pollIntervalMs: 0,
  ...over,
})

describe('runDeploy', () => {
  it('deploys, polls until running, then persists the agent', async () => {
    const onDeployed = mockOnDeployed()
    let calls = 0
    const pollStatus = () => Promise.resolve(calls++ === 0 ? pending : running('wss://h/ws?pipeline=tb-x'))
    const result = await runDeploy(descriptor, { name: 'Bot' }, baseDeps({ onDeployed, pollStatus }))
    expect(result).toEqual({ ok: true })
    expect(onDeployed.mock.calls[0][0]).toEqual({
      name: 'Bot',
      connection: { url: 'wss://h/ws?pipeline=tb-x', transport: 'websocket' },
    })
  })

  it('passes descriptorId + schemaVersion to deploy', async () => {
    const deploy = mockDeploy()
    await runDeploy(descriptor, { name: 'Bot' }, baseDeps({ deploy }))
    expect(deploy.mock.calls[0][0]).toEqual({ descriptorId: 'haystack', schemaVersion: 2, spec: { name: 'Bot' } })
  })

  it('falls back to the descriptor name when the spec has none', async () => {
    const onDeployed = mockOnDeployed()
    await runDeploy(descriptor, {}, baseDeps({ onDeployed }))
    expect(onDeployed.mock.calls[0][0].name).toBe('Haystack')
  })

  it('returns the failure detail when the deployment fails', async () => {
    const pollStatus = () =>
      Promise.resolve<DeploymentStatusResponse>({ deploymentId: 'haystack:tb-x', status: 'failed', detail: 'bad yaml' })
    const result = await runDeploy(descriptor, { name: 'Bot' }, baseDeps({ pollStatus }))
    expect(result).toEqual({ ok: false, error: 'bad yaml' })
  })

  it('errors when running but no connection is returned', async () => {
    const pollStatus = () =>
      Promise.resolve<DeploymentStatusResponse>({ deploymentId: 'haystack:tb-x', status: 'running', connection: null })
    const result = await runDeploy(descriptor, { name: 'Bot' }, baseDeps({ pollStatus }))
    expect(result.ok).toBe(false)
  })

  it('stops when cancelled', async () => {
    const onDeployed = mockOnDeployed()
    const result = await runDeploy(
      descriptor,
      { name: 'Bot' },
      baseDeps({ isCancelled: () => true, onDeployed, pollStatus: () => Promise.resolve(pending) }),
    )
    expect(result).toEqual({ ok: false, error: 'Deployment cancelled.' })
    expect(onDeployed).not.toHaveBeenCalled()
  })

  it('times out after maxAttempts of non-terminal status', async () => {
    const result = await runDeploy(
      descriptor,
      { name: 'Bot' },
      baseDeps({ pollStatus: () => Promise.resolve(pending), maxAttempts: 3 }),
    )
    expect(result.ok).toBe(false)
  })
})
