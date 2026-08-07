/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ProviderContext } from '@/agents'
import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, test } from 'bun:test'
import type { E2bClient, E2bSandbox } from './e2b'
import { createOpenclawProvider, openclawProviderId, type OpenclawProviderDeps } from './provider'

const configuredSettings = () =>
  createTestSettings({
    e2bApiKey: 'e2b-key',
    publicApiUrl: 'https://api.thunderbolt.example',
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
  setTimeout: async () => {},
})

/** Fake DB + DAL/token hooks that record calls without a real database. */
const fakeDeps = (
  overrides: Partial<OpenclawProviderDeps> = {},
): OpenclawProviderDeps & {
  recorded: { deploymentId: string; userId: string }[]
  minted: { deploymentId: string; expiresInSeconds: number | null }[]
  revoked: string[]
} => {
  const recorded: { deploymentId: string; userId: string }[] = []
  const minted: { deploymentId: string; expiresInSeconds: number | null }[] = []
  const revoked: string[] = []
  return {
    client: fakeClient(),
    database: {} as never,
    recordDeployment: async (_database, args) => {
      recorded.push(args)
      return []
    },
    mintToken: async ({ deploymentId, expiresInSeconds }) => {
      minted.push({ deploymentId, expiresInSeconds })
      return 'agent-token'
    },
    revokeDeployment: async (_database, deploymentId) => {
      revoked.push(deploymentId)
      return []
    },
    ...overrides,
    recorded,
    minted,
    revoked,
  }
}

const ctx = (userId: string): ProviderContext => ({
  request: new Request('http://localhost:8000/v1/agents/deploy'),
  settings: configuredSettings(),
  userId,
})

describe('createOpenclawProvider', () => {
  test('catalog is exposed only when configured (E2B + public API url)', () => {
    const provider = createOpenclawProvider()
    expect(provider.catalog?.({ ...ctx('user-a'), settings: configuredSettings() })).toHaveLength(1)
    expect(
      provider.catalog?.({ ...ctx('user-a'), settings: createTestSettings({ e2bApiKey: '', publicApiUrl: '' }) }),
    ).toEqual([])
  })

  test('catalog ships schemaVersion 2 with a required fetched model field', () => {
    const [descriptor] = createOpenclawProvider().catalog?.({ ...ctx('user-a'), settings: configuredSettings() }) ?? []
    expect(descriptor?.schemaVersion).toBe(2)
    const modelField = descriptor?.steps.flatMap((s) => s.fields).find((f) => f.key === 'model')
    expect(modelField?.required).toBe(true)
    expect(modelField?.source).toEqual({ kind: 'fetched', sourceId: 'account-models' })
  })

  test('list is empty — deployed instances live in the synced agents table', async () => {
    const provider = createOpenclawProvider()
    expect(await provider.list(new Request('http://localhost'), createTestSettings())).toEqual([])
  })

  test('deploy records the deployment, mints a non-expiring token, and returns the relay as pending', async () => {
    const deps = fakeDeps()
    const provider = createOpenclawProvider(deps)
    const result = await provider.deploy!({ model: 'opus-4.8' }, ctx('user-a'))

    expect(result.deploymentId).toBe(`${openclawProviderId}:e2b:sbx-1`)
    expect(result.status).toBe('pending')
    expect(result.connection?.transport).toBe('websocket')
    expect(result.connection?.url).toBe('ws://localhost:8000/v1/openclaw/ws?instance=e2b%3Asbx-1')

    expect(deps.recorded).toEqual([{ deploymentId: `${openclawProviderId}:e2b:sbx-1`, userId: 'user-a' }])
    expect(deps.minted).toEqual([{ deploymentId: `${openclawProviderId}:e2b:sbx-1`, expiresInSeconds: null }])
  })

  test('deploy rejects an unservable model and never creates a sandbox', async () => {
    let created = false
    const deps = fakeDeps({
      client: {
        ...fakeClient(),
        create: async () => {
          created = true
          return makeSandbox('sbx-1')
        },
      },
    })
    const provider = createOpenclawProvider(deps)

    await expect(provider.deploy!({ model: 'glm-5-2' }, ctx('user-a'))).rejects.toThrow(/unsupported model/i)
    await expect(provider.deploy!({}, ctx('user-a'))).rejects.toThrow(/unsupported model/i)
    expect(created).toBe(false)
    expect(deps.recorded).toEqual([])
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

  test('undeploy revokes the deployment then kills the owner sandbox and reports gone', async () => {
    const killed: string[] = []
    const deps = fakeDeps({
      client: {
        ...fakeClient({ 'sbx-1': { userId: 'user-a' } }),
        kill: async (sandboxId) => {
          killed.push(sandboxId)
        },
      },
    })
    const provider = createOpenclawProvider(deps)

    const result = await provider.undeploy!('e2b:sbx-1', ctx('user-a'))
    expect(result).toEqual({ deploymentId: `${openclawProviderId}:e2b:sbx-1`, status: 'gone' })
    expect(deps.revoked).toEqual([`${openclawProviderId}:e2b:sbx-1`])
    expect(killed).toEqual(['sbx-1'])
  })

  test('undeploy revokes (idempotent) but never kills another tenant sandbox, still reports gone', async () => {
    const killed: string[] = []
    const deps = fakeDeps({
      client: {
        ...fakeClient({ 'sbx-1': { userId: 'victim' } }),
        kill: async (sandboxId) => {
          killed.push(sandboxId)
        },
      },
    })
    const provider = createOpenclawProvider(deps)

    const result = await provider.undeploy!('e2b:sbx-1', ctx('attacker'))
    expect(result.status).toBe('gone')
    expect(deps.revoked).toEqual([`${openclawProviderId}:e2b:sbx-1`])
    expect(killed).toEqual([])
  })

  test('undeploy is a no-op for a malformed ref — neither revoke nor kill', async () => {
    const killed: string[] = []
    const deps = fakeDeps({
      client: {
        ...fakeClient(),
        kill: async (sandboxId) => {
          killed.push(sandboxId)
        },
      },
    })
    const provider = createOpenclawProvider(deps)

    const result = await provider.undeploy!('not-a-ref', ctx('user-a'))
    expect(result.status).toBe('gone')
    expect(deps.revoked).toEqual([])
    expect(killed).toEqual([])
  })
})
