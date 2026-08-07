/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The built-in placement truth table.
 *
 * `resolveBuiltInPlacement` is pure, so the eligibility matrix is exhaustible:
 * one baseline that IS eligible, then one case per disqualifier flipped on its
 * own. `decideBuiltInPlacement` is covered through its DI seam — no DB or
 * localStorage.
 */

import { describe, expect, it } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import type { Model } from '@/types'
import type { Agent } from '@/types/acp'
import {
  builtInPlacementRefusalMessage,
  decideBuiltInPlacement,
  resolveBuiltInPlacement,
  type BuiltInPlacementDeps,
  type BuiltInPlacementInputs,
  type BuiltInPlacementReason,
  type BuiltInPlacementRequest,
} from './built-in-placement'

const gatewayModel = {
  id: 'model-row-id',
  model: 'thunderbolt/opus-mini',
  provider: 'thunderbolt',
  isConfidential: 0,
  toolUsage: 1,
} as Model

const customAgent: Agent = {
  id: 'custom-1',
  name: 'My agent',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://elsewhere.test',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'user-1',
}

/** An eligible first send: every gate open. Each test flips exactly one input. */
const eligible: BuiltInPlacementInputs = {
  agent: builtInAgent,
  isRunnerOwned: false,
  isEncryptedThread: false,
  model: gatewayModel,
  runnerWsUrl: 'wss://runner.test/ws',
  hasPriorTurns: false,
  isAuthenticated: true,
  isStandalone: false,
  hasMcpClients: false,
  hasDeviceOnlyTools: false,
  hasAttachments: false,
}

const resolve = (overrides: Partial<BuiltInPlacementInputs> = {}) =>
  resolveBuiltInPlacement({ ...eligible, ...overrides })

describe('resolveBuiltInPlacement — first turn', () => {
  it('places an eligible first send on the runner', () => {
    expect(resolve()).toEqual({ placement: 'runner', reason: 'eligible' })
  })

  const disqualifiers: readonly [string, Partial<BuiltInPlacementInputs>, BuiltInPlacementReason][] = [
    ['the selected agent is not the built-in one', { agent: customAgent }, 'not-built-in-agent'],
    ['the thread already has local turns', { hasPriorTurns: true }, 'thread-already-local'],
    ['the deployment runs no runner', { runnerWsUrl: null }, 'no-runner-configured'],
    ['the device holds no account', { isAuthenticated: false }, 'not-authenticated'],
    ['the app runs standalone', { isStandalone: true }, 'standalone'],
    ['the thread is encrypted', { isEncryptedThread: true }, 'encrypted-thread'],
    ['the model is confidential', { model: { ...gatewayModel, isConfidential: 1 } as Model }, 'confidential-model'],
    [
      'the model is not served by the gateway',
      { model: { ...gatewayModel, provider: 'openai' } as Model },
      'model-not-on-gateway',
    ],
    ['the model cannot call tools', { model: { ...gatewayModel, toolUsage: 0 } as Model }, 'model-without-tool-use'],
    ['an MCP client is enabled', { hasMcpClients: true }, 'mcp-clients-enabled'],
    ['a device-only tool is enabled', { hasDeviceOnlyTools: true }, 'device-only-tools-enabled'],
    ['the message carries attachments', { hasAttachments: true }, 'attachments'],
  ]

  for (const [label, overrides, reason] of disqualifiers) {
    it(`stays local when ${label}`, () => {
      expect(resolve(overrides)).toEqual({ placement: 'local', reason })
    })
  }

  it('does not disqualify on a model id, so catalog changes cannot break placement', () => {
    const renamed = { ...gatewayModel, id: 'row-2', model: 'thunderbolt/next-gen-2030' } as Model
    expect(resolve({ model: renamed }).placement).toBe('runner')
  })

  it('treats a blank runner url as no runner', () => {
    expect(resolve({ runnerWsUrl: '' }).placement).toBe('local')
  })
})

describe('resolveBuiltInPlacement — runner-owned thread', () => {
  const owned = (overrides: Partial<BuiltInPlacementInputs> = {}) =>
    resolve({ isRunnerOwned: true, hasPriorTurns: true, ...overrides })

  it('keeps sending to the runner', () => {
    expect(owned()).toEqual({ placement: 'runner', reason: 'runner-owned' })
  })

  it('ignores every first-turn gate — placement was pinned at the first send', () => {
    expect(
      owned({
        isAuthenticated: false,
        isStandalone: true,
        model: { ...gatewayModel, provider: 'openai', toolUsage: 0 } as Model,
      }).placement,
    ).toBe('runner')
  })

  it('refuses rather than leaking an encrypted thread to the runner', () => {
    expect(owned({ isEncryptedThread: true })).toEqual({
      placement: 'refuse',
      reason: 'runner-owned-encrypted',
    })
  })

  it('refuses when the runner endpoint disappeared from config', () => {
    expect(owned({ runnerWsUrl: null })).toEqual({
      placement: 'refuse',
      reason: 'runner-owned-unreachable',
    })
  })

  it('refuses an attachment added after the thread was pinned', () => {
    expect(owned({ hasAttachments: true })).toEqual({
      placement: 'refuse',
      reason: 'runner-owned-needs-attachments',
    })
  })

  it('refuses when an MCP client was enabled after the thread was pinned', () => {
    expect(owned({ hasMcpClients: true })).toEqual({
      placement: 'refuse',
      reason: 'runner-owned-needs-device-tools',
    })
  })

  it('refuses when a device-only tool was enabled after the thread was pinned', () => {
    expect(owned({ hasDeviceOnlyTools: true })).toEqual({
      placement: 'refuse',
      reason: 'runner-owned-needs-device-tools',
    })
  })

  it('never refuses a thread whose agent is no longer the built-in one', () => {
    expect(owned({ agent: customAgent })).toEqual({ placement: 'local', reason: 'not-built-in-agent' })
  })
})

describe('builtInPlacementRefusalMessage', () => {
  it('explains each refusal in the user’s terms', () => {
    expect(builtInPlacementRefusalMessage('runner-owned-encrypted')).toContain('Encrypted')
    expect(builtInPlacementRefusalMessage('runner-owned-needs-attachments')).toContain('files')
    expect(builtInPlacementRefusalMessage('runner-owned-needs-device-tools')).toContain('tools')
    expect(builtInPlacementRefusalMessage('runner-owned-unreachable')).toContain('unavailable')
  })

  it('falls back to a generic message for reasons that never refuse', () => {
    expect(builtInPlacementRefusalMessage('eligible')).toBe('This conversation cannot continue on Thunderbolt servers.')
  })
})

const request: BuiltInPlacementRequest = {
  agent: builtInAgent,
  isRunnerOwned: false,
  isEncryptedThread: false,
  model: gatewayModel,
  runnerWsUrl: 'wss://runner.test/ws',
  hasPriorTurns: false,
  hasMcpClients: false,
  hasAttachments: false,
}

const oneHourAhead = () => new Date(Date.now() + 3_600_000).toISOString()

const deps = (overrides: BuiltInPlacementDeps = {}): BuiltInPlacementDeps => ({
  getAuthToken: () => 'token',
  getCachedSession: () => ({ user: { isAnonymous: false }, session: { expiresAt: oneHourAhead() } }),
  isStandaloneMode: () => false,
  getDb: (() => ({})) as BuiltInPlacementDeps['getDb'],
  getSettings: (async () => ({
    experimentalFeatureTasks: false,
  })) as BuiltInPlacementDeps['getSettings'],
  getIntegrationStatus: (async () => ({
    googleConnected: false,
    googleEnabled: false,
    googleEmail: null,
    microsoftConnected: false,
    microsoftEnabled: false,
    microsoftEmail: null,
  })) as BuiltInPlacementDeps['getIntegrationStatus'],
  ...overrides,
})

describe('decideBuiltInPlacement', () => {
  it('places an eligible send on the runner', async () => {
    expect(await decideBuiltInPlacement(request, deps())).toEqual({ placement: 'runner', reason: 'eligible' })
  })

  it('reads no account as local', async () => {
    const decision = await decideBuiltInPlacement(request, deps({ getAuthToken: () => null }))
    expect(decision).toEqual({ placement: 'local', reason: 'not-authenticated' })
  })

  it('rejects an anonymous session — the runner scopes sessions to an owner', async () => {
    const anonymous = deps({
      getCachedSession: () => ({ user: { isAnonymous: true }, session: { expiresAt: oneHourAhead() } }),
    })
    expect((await decideBuiltInPlacement(request, anonymous)).reason).toBe('not-authenticated')
  })

  it('rejects an expired cached session', async () => {
    const expired = deps({
      getCachedSession: () => ({ user: { isAnonymous: false }, session: { expiresAt: '2000-01-01T00:00:00Z' } }),
    })
    expect((await decideBuiltInPlacement(request, expired)).reason).toBe('not-authenticated')
  })

  it('rejects a missing cached session even with a stored token', async () => {
    expect((await decideBuiltInPlacement(request, deps({ getCachedSession: () => null }))).reason).toBe(
      'not-authenticated',
    )
  })

  it('reads standalone mode as local', async () => {
    const decision = await decideBuiltInPlacement(request, deps({ isStandaloneMode: () => true }))
    expect(decision).toEqual({ placement: 'local', reason: 'standalone' })
  })

  it('reads the tasks extension as a device-only tool', async () => {
    const withTasks = deps({
      getSettings: (async () => ({
        experimentalFeatureTasks: true,
      })) as BuiltInPlacementDeps['getSettings'],
    })
    expect((await decideBuiltInPlacement(request, withTasks)).reason).toBe('device-only-tools-enabled')
  })

  it('reads an enabled Google integration as a device-only tool', async () => {
    const withGoogle = deps({
      getIntegrationStatus: (async () => ({
        googleConnected: true,
        googleEnabled: true,
        googleEmail: 'a@b.test',
        microsoftConnected: false,
        microsoftEnabled: false,
        microsoftEmail: null,
      })) as BuiltInPlacementDeps['getIntegrationStatus'],
    })
    expect((await decideBuiltInPlacement(request, withGoogle)).reason).toBe('device-only-tools-enabled')
  })

  it('reads an enabled Microsoft integration as a device-only tool', async () => {
    const withMicrosoft = deps({
      getIntegrationStatus: (async () => ({
        googleConnected: false,
        googleEnabled: false,
        googleEmail: null,
        microsoftConnected: true,
        microsoftEnabled: true,
        microsoftEmail: 'a@b.test',
      })) as BuiltInPlacementDeps['getIntegrationStatus'],
    })
    expect((await decideBuiltInPlacement(request, withMicrosoft)).reason).toBe('device-only-tools-enabled')
  })

  it('does not count the Pro toolset as device-only — the runner serves search/fetch itself', async () => {
    // Pro enablement no longer feeds the decision at all: with nothing else
    // disqualifying, the send goes to the runner regardless of entitlement.
    expect(await decideBuiltInPlacement(request, deps())).toEqual({ placement: 'runner', reason: 'eligible' })
  })

  it('skips the tool reads entirely when something cheaper already rules the runner out', async () => {
    let settingsReads = 0
    const counting = deps({
      getSettings: (async () => {
        settingsReads++
        return { experimentalFeatureTasks: false }
      }) as BuiltInPlacementDeps['getSettings'],
    })

    await decideBuiltInPlacement({ ...request, runnerWsUrl: null }, counting)

    expect(settingsReads).toBe(0)
  })

  it('still checks device-only tools on a runner-owned thread, so a newly enabled one refuses', async () => {
    const withTasks = deps({
      getSettings: (async () => ({
        experimentalFeatureTasks: true,
      })) as BuiltInPlacementDeps['getSettings'],
    })

    expect(await decideBuiltInPlacement({ ...request, isRunnerOwned: true }, withTasks)).toEqual({
      placement: 'refuse',
      reason: 'runner-owned-needs-device-tools',
    })
  })
})
