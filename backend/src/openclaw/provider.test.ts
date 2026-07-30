/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ProviderContext } from '@/agents'
import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, test } from 'bun:test'
import type { E2bClient, E2bSandbox } from './e2b'
import { createOpenclawProvider, openclawProviderId } from './provider'

const configuredSettings = () =>
  createTestSettings({
    e2bApiKey: 'e2b-key',
    openclawModel: 'openrouter/some-model',
    openclawOpenrouterApiKey: 'or-key',
  })

const makeSandbox = (sandboxId: string): E2bSandbox => ({
  sandboxId,
  getHost: (port) => `${port}-${sandboxId}.e2b.app`,
  commands: { run: async () => {} },
  kill: async () => {},
})

/** Fake E2B client driving both deploy and the owner-gated status check. */
const fakeClient = (metadataById: Record<string, Record<string, string>> = {}): E2bClient => ({
  create: async () => makeSandbox('sbx-1'),
  connect: async (sandboxId) => makeSandbox(sandboxId),
  getMetadata: async (sandboxId) => metadataById[sandboxId] ?? null,
  kill: async () => {},
})

const ctx = (userId: string): ProviderContext => ({
  request: new Request('http://localhost:8000/v1/agents/deploy'),
  settings: configuredSettings(),
  userId,
})

describe('createOpenclawProvider', () => {
  test('catalog is exposed only when configured', () => {
    const provider = createOpenclawProvider()
    expect(provider.catalog?.({ ...ctx('user-a'), settings: configuredSettings() })).toHaveLength(1)
    expect(provider.catalog?.({ ...ctx('user-a'), settings: createTestSettings() })).toEqual([])
  })

  test('list is empty — deployed instances live in the synced agents table', async () => {
    const provider = createOpenclawProvider()
    expect(await provider.list(new Request('http://localhost'), createTestSettings())).toEqual([])
  })

  test('deploy provisions a sandbox and returns the relay connection as pending', async () => {
    const provider = createOpenclawProvider({ client: fakeClient() })
    const result = await provider.deploy!({}, ctx('user-a'))

    expect(result.deploymentId).toBe(`${openclawProviderId}:e2b:sbx-1`)
    expect(result.status).toBe('pending')
    expect(result.connection?.transport).toBe('websocket')
    expect(result.connection?.url).toBe('ws://localhost:8000/v1/openclaw/ws?instance=e2b%3Asbx-1')
  })

  test('status is running (with connection) once ACP answers, pending while it boots', async () => {
    const owned = fakeClient({ 'sbx-1': { userId: 'user-a' } })
    const ready = createOpenclawProvider({ client: owned, isAcpReady: async () => true })
    const running = await ready.status!('e2b:sbx-1', ctx('user-a'))
    expect(running.status).toBe('running')
    expect(running.connection?.url).toContain('instance=e2b%3Asbx-1')

    const booting = createOpenclawProvider({ client: owned, isAcpReady: async () => false })
    const pending = await booting.status!('e2b:sbx-1', ctx('user-a'))
    expect(pending.status).toBe('pending')
    expect(pending.connection).toBeNull()
  })

  test('status is gone for another user, a missing sandbox, or a malformed ref', async () => {
    const provider = createOpenclawProvider({
      client: fakeClient({ 'sbx-1': { userId: 'victim' } }),
      isAcpReady: async () => true,
    })

    const otherUser = await provider.status!('e2b:sbx-1', ctx('attacker'))
    expect(otherUser.status).toBe('gone')
    expect(otherUser.connection).toBeNull()

    const missing = await provider.status!('e2b:ghost', ctx('user-a'))
    expect(missing.status).toBe('gone')

    const malformed = await provider.status!('not-a-ref', ctx('user-a'))
    expect(malformed.status).toBe('gone')
  })

  test('undeploy kills the owner sandbox and reports gone', async () => {
    const killed: string[] = []
    const client: E2bClient = {
      ...fakeClient({ 'sbx-1': { userId: 'user-a' } }),
      kill: async (sandboxId) => {
        killed.push(sandboxId)
      },
    }
    const provider = createOpenclawProvider({ client })

    const result = await provider.undeploy!('e2b:sbx-1', ctx('user-a'))
    expect(result).toEqual({ deploymentId: `${openclawProviderId}:e2b:sbx-1`, status: 'gone' })
    expect(killed).toEqual(['sbx-1'])
  })

  test('undeploy never kills another tenant sandbox but still reports gone (idempotent)', async () => {
    const killed: string[] = []
    const client: E2bClient = {
      ...fakeClient({ 'sbx-1': { userId: 'victim' } }),
      kill: async (sandboxId) => {
        killed.push(sandboxId)
      },
    }
    const provider = createOpenclawProvider({ client })

    const result = await provider.undeploy!('e2b:sbx-1', ctx('attacker'))
    expect(result.status).toBe('gone')
    expect(killed).toEqual([])
  })

  test('undeploy is a no-op for a malformed ref', async () => {
    const killed: string[] = []
    const client: E2bClient = {
      ...fakeClient(),
      kill: async (sandboxId) => {
        killed.push(sandboxId)
      },
    }
    const provider = createOpenclawProvider({ client })

    const result = await provider.undeploy!('not-a-ref', ctx('user-a'))
    expect(result.status).toBe('gone')
    expect(killed).toEqual([])
  })
})
