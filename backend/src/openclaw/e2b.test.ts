/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  deployOpenclawSandbox,
  openclawSandboxStatusForUser,
  resolveOpenclawSandboxForUser,
  type E2bClient,
  type E2bSandbox,
  type OpenclawE2bConfig,
} from './e2b'

const config: OpenclawE2bConfig = {
  apiKey: 'e2b-key',
  model: 'openrouter/some-model',
  openrouterApiKey: 'or-key',
}

/** A fake E2B client that records calls and serves scripted metadata. */
const fakeClient = (overrides: Partial<E2bClient> & { metadataById?: Record<string, Record<string, string>> } = {}) => {
  const created: { template: string; opts: Parameters<E2bClient['create']>[1] }[] = []
  const ran: string[] = []
  const killed: string[] = []
  const connected: string[] = []

  const makeSandbox = (sandboxId: string): E2bSandbox => ({
    sandboxId,
    getHost: (port) => `${port}-${sandboxId}.e2b.app`,
    commands: {
      run: async (cmd) => {
        ran.push(cmd)
      },
    },
    kill: async () => {
      killed.push(sandboxId)
    },
  })

  const client: E2bClient = {
    create: async (template, opts) => {
      created.push({ template, opts })
      return makeSandbox('sbx-1')
    },
    connect: async (sandboxId) => {
      connected.push(sandboxId)
      return makeSandbox(sandboxId)
    },
    getMetadata: async (sandboxId) => overrides.metadataById?.[sandboxId] ?? null,
    kill: async (sandboxId) => {
      killed.push(sandboxId)
    },
    ...overrides,
  }
  return { client, created, ran, killed, connected }
}

describe('deployOpenclawSandbox', () => {
  test('stamps owner metadata + envs, launches the entrypoint, returns the handle without waiting', async () => {
    const fake = fakeClient()

    const result = await deployOpenclawSandbox('user-a', config, { client: fake.client })

    expect(result).toEqual({ sandboxId: 'sbx-1', wsUrl: 'wss://8790-sbx-1.e2b.app' })
    expect(fake.created[0]?.template).toBe('thunderbolt-openclaw')
    expect(fake.created[0]?.opts.metadata).toEqual({ userId: 'user-a', kind: 'openclaw' })
    expect(fake.created[0]?.opts.envs.OPENROUTER_API_KEY).toBe('or-key')
    expect(fake.created[0]?.opts.envs.MODEL).toBe('openrouter/some-model')
    expect(fake.created[0]?.opts.secure).toBe(false)
    expect(fake.ran).toEqual([
      "sh -c 'setsid nohup bash /opt/docker-entrypoint.sh >/tmp/openclaw-boot.log 2>&1 </dev/null & sleep 2'",
    ])
  })

  test('kills the sandbox when the launch command fails', async () => {
    let killedSelf = false
    const client = {
      ...fakeClient().client,
      create: async (): Promise<E2bSandbox> => ({
        sandboxId: 'sbx-1',
        getHost: (port) => `${port}-sbx-1.e2b.app`,
        commands: {
          run: async () => {
            throw new Error('launch failed')
          },
        },
        kill: async () => {
          killedSelf = true
        },
      }),
    }

    await expect(deployOpenclawSandbox('user-a', config, { client })).rejects.toThrow('launch failed')
    expect(killedSelf).toBe(true)
  })
})

describe('resolveOpenclawSandboxForUser', () => {
  test('returns the handle when the caller owns the sandbox', async () => {
    const fake = fakeClient({ metadataById: { 'sbx-9': { userId: 'user-a', kind: 'openclaw' } } })
    const result = await resolveOpenclawSandboxForUser('sbx-9', 'user-a', config.apiKey, { client: fake.client })
    expect(result).toEqual({ sandboxId: 'sbx-9', wsUrl: 'wss://8790-sbx-9.e2b.app' })
    expect(fake.connected).toEqual(['sbx-9'])
  })

  test('returns null and never connects when another user owns the sandbox', async () => {
    const fake = fakeClient({ metadataById: { 'sbx-9': { userId: 'victim', kind: 'openclaw' } } })
    const result = await resolveOpenclawSandboxForUser('sbx-9', 'attacker', config.apiKey, { client: fake.client })
    expect(result).toBeNull()
    expect(fake.connected).toEqual([]) // cross-tenant relay never dials
  })

  test('returns null when the sandbox no longer exists', async () => {
    const fake = fakeClient({ metadataById: {} })
    const result = await resolveOpenclawSandboxForUser('gone', 'user-a', config.apiKey, { client: fake.client })
    expect(result).toBeNull()
  })
})

describe('openclawSandboxStatusForUser', () => {
  test('running once the owner sandbox answers ACP', async () => {
    const fake = fakeClient({ metadataById: { 'sbx-9': { userId: 'user-a' } } })
    const status = await openclawSandboxStatusForUser('sbx-9', 'user-a', config.apiKey, {
      client: fake.client,
      isAcpReady: async () => true,
    })
    expect(status).toBe('running')
  })

  test('pending while the owner sandbox is up but ACP is not answering yet', async () => {
    const fake = fakeClient({ metadataById: { 'sbx-9': { userId: 'user-a' } } })
    const status = await openclawSandboxStatusForUser('sbx-9', 'user-a', config.apiKey, {
      client: fake.client,
      isAcpReady: async () => false,
    })
    expect(status).toBe('pending')
  })

  test('gone for another user or a missing sandbox, without probing ACP', async () => {
    const fake = fakeClient({ metadataById: { 'sbx-9': { userId: 'victim' } } })
    let probed = false
    const isAcpReady = async () => {
      probed = true
      return true
    }
    expect(
      await openclawSandboxStatusForUser('sbx-9', 'attacker', config.apiKey, { client: fake.client, isAcpReady }),
    ).toBe('gone')
    expect(
      await openclawSandboxStatusForUser('missing', 'user-a', config.apiKey, { client: fake.client, isAcpReady }),
    ).toBe('gone')
    expect(probed).toBe(false)
  })
})
