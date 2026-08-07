/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  deployOpenclawSandbox,
  extendOpenclawSandboxTimeout,
  killOpenclawSandboxForUser,
  openclawSandboxStatusForUser,
  resolveOpenclawSandboxForUser,
  type E2bClient,
  type E2bSandbox,
  type OpenclawDeployHooks,
  type OpenclawE2bConfig,
} from './e2b'

const config: OpenclawE2bConfig = {
  apiKey: 'e2b-key',
  publicApiUrl: 'https://api.thunderbolt.example',
  model: 'opus-4.8',
}

/** Deploy hooks that record their order + arguments and hand back a scripted token. */
const fakeHooks = (): OpenclawDeployHooks & {
  events: string[]
  recordedSandboxId?: string
  mintedSandboxId?: string
} => {
  const state = {
    events: [] as string[],
    recordedSandboxId: undefined as string | undefined,
    mintedSandboxId: undefined as string | undefined,
    recordDeployment: async (sandboxId: string) => {
      state.events.push('record')
      state.recordedSandboxId = sandboxId
    },
    mintToken: async (sandboxId: string) => {
      state.events.push('mint')
      state.mintedSandboxId = sandboxId
      return 'agent-token'
    },
  }
  return state
}

/** A fake E2B client that records calls and serves scripted metadata. */
const fakeClient = (overrides: Partial<E2bClient> & { metadataById?: Record<string, Record<string, string>> } = {}) => {
  const created: { template: string; opts: Parameters<E2bClient['create']>[1] }[] = []
  const ran: { cmd: string; envs?: Record<string, string> }[] = []
  const killed: string[] = []
  const connected: string[] = []
  const timeouts: { sandboxId: string; timeoutMs: number }[] = []
  const events: string[] = []

  const makeSandbox = (sandboxId: string): E2bSandbox => ({
    sandboxId,
    getHost: (port) => `${port}-${sandboxId}.e2b.app`,
    commands: {
      run: async (cmd, opts) => {
        events.push('run')
        ran.push({ cmd, envs: opts.envs })
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
    setTimeout: async (sandboxId, timeoutMs) => {
      timeouts.push({ sandboxId, timeoutMs })
    },
    ...overrides,
  }
  return { client, created, ran, killed, connected, timeouts, events }
}

const idleTimeoutMs = 15 * 60 * 1000

describe('deployOpenclawSandbox', () => {
  test('injects managed-inference env, auto-pause + idle timeout, mints before launch, returns the handle', async () => {
    const fake = fakeClient()
    const hooks = fakeHooks()

    const result = await deployOpenclawSandbox('user-a', config, hooks, { client: fake.client })

    expect(result).toEqual({ sandboxId: 'sbx-1', wsUrl: 'wss://8790-sbx-1.e2b.app' })

    const createOpts = fake.created[0]?.opts
    expect(fake.created[0]?.template).toBe('thunderbolt-openclaw')
    expect(createOpts?.metadata).toEqual({ userId: 'user-a', kind: 'openclaw' })
    expect(createOpts?.secure).toBe(false)
    expect(createOpts?.autoPause).toBe(true)
    expect(createOpts?.timeoutMs).toBe(idleTimeoutMs)

    // We run our own launch script (custom OpenAI-compatible provider), NOT the
    // image's OpenRouter-wired entrypoint.
    expect(fake.ran[0]?.cmd).toContain('/tmp/openclaw-launch.sh')
    expect(fake.ran[0]?.cmd).not.toContain('docker-entrypoint.sh')

    // The launch (not create) carries the minted token as OPENAI_API_KEY, and the
    // bare model id (the launch onboards it as the custom provider's model).
    const launchEnvs = fake.ran[0]?.envs ?? {}
    expect(launchEnvs.OPENAI_BASE_URL).toBe('https://api.thunderbolt.example/v1')
    expect(launchEnvs.OPENAI_API_KEY).toBe('agent-token')
    expect(launchEnvs.MODEL).toBe('opus-4.8')
    expect(launchEnvs.PORT).toBe('8790')
    expect(launchEnvs.OPENROUTER_API_KEY).toBeUndefined()

    // Recorded, then minted (with the created sandbox id), then launched.
    expect(hooks.events).toEqual(['record', 'mint'])
    expect(fake.events).toEqual(['run'])
    expect(hooks.recordedSandboxId).toBe('sbx-1')
    expect(hooks.mintedSandboxId).toBe('sbx-1')
  })

  test('kills the sandbox when recording the deployment fails, before minting or launching', async () => {
    const fake = fakeClient()
    const hooks: OpenclawDeployHooks = {
      recordDeployment: async () => {
        throw new Error('db down')
      },
      mintToken: async () => 'unused',
    }

    await expect(deployOpenclawSandbox('user-a', config, hooks, { client: fake.client })).rejects.toThrow('db down')
    expect(fake.killed).toEqual(['sbx-1'])
    expect(fake.ran).toEqual([])
  })

  test('kills the sandbox when minting the token fails', async () => {
    const fake = fakeClient()
    const hooks: OpenclawDeployHooks = {
      recordDeployment: async () => {},
      mintToken: async () => {
        throw new Error('mint failed')
      },
    }

    await expect(deployOpenclawSandbox('user-a', config, hooks, { client: fake.client })).rejects.toThrow('mint failed')
    expect(fake.killed).toEqual(['sbx-1'])
    expect(fake.ran).toEqual([])
  })

  test('kills the sandbox when the launch command fails', async () => {
    let killedSelf = false
    const client: E2bClient = {
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

    await expect(deployOpenclawSandbox('user-a', config, fakeHooks(), { client })).rejects.toThrow('launch failed')
    expect(killedSelf).toBe(true)
  })
})

describe('extendOpenclawSandboxTimeout', () => {
  test('pushes the idle timeout back out to the idle window', async () => {
    const fake = fakeClient()
    await extendOpenclawSandboxTimeout('sbx-9', config.apiKey, { client: fake.client })
    expect(fake.timeouts).toEqual([{ sandboxId: 'sbx-9', timeoutMs: idleTimeoutMs }])
  })

  test('swallows failures so a transient E2B hiccup never drops the relay', async () => {
    const client: E2bClient = {
      ...fakeClient().client,
      setTimeout: async () => {
        throw new Error('e2b unreachable')
      },
    }
    await expect(extendOpenclawSandboxTimeout('sbx-9', config.apiKey, { client })).resolves.toBeUndefined()
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

describe('killOpenclawSandboxForUser', () => {
  test('kills the sandbox when the caller owns it', async () => {
    const fake = fakeClient({ metadataById: { 'sbx-9': { userId: 'user-a', kind: 'openclaw' } } })
    const result = await killOpenclawSandboxForUser('sbx-9', 'user-a', config.apiKey, { client: fake.client })
    expect(result).toBe(true)
    expect(fake.killed).toEqual(['sbx-9'])
  })

  test('never kills another tenant sandbox', async () => {
    const fake = fakeClient({ metadataById: { 'sbx-9': { userId: 'victim', kind: 'openclaw' } } })
    const result = await killOpenclawSandboxForUser('sbx-9', 'attacker', config.apiKey, { client: fake.client })
    expect(result).toBe(false)
    expect(fake.killed).toEqual([])
  })

  test('no-op for a missing / already-gone sandbox', async () => {
    const fake = fakeClient({ metadataById: {} })
    const result = await killOpenclawSandboxForUser('gone', 'user-a', config.apiKey, { client: fake.client })
    expect(result).toBe(false)
    expect(fake.killed).toEqual([])
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
