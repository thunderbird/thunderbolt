/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Route-level tests for `GET /agents`. Following backend/docs/testing.md:
 * - DI for the `Auth` mock (no module mocks).
 * - Env-var manipulation around `clearSettingsCache()` for the env-driven branches.
 * - Each test resets the provider registry via `resetAgentProvidersForTesting()` so
 *   provider state never leaks between cases.
 *
 * No DB access is required — the discovery route is purely settings + registry,
 * so we skip `createTestDb()` for speed.
 */

import type { Auth } from '@/auth/elysia-plugin'
import { clearSettingsCache } from '@/config/settings'
import type { RemoteAgentDescriptor } from '@shared/acp-types'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createHostedAgentProvider } from '@/hosted-agent/provider'
import { registerAgentProvider, resetAgentProvidersForTesting } from './discovery'
import { createAgentsRoutes } from './routes'

/** Build an `Auth` whose `getSession` returns the provided user shape. */
const buildAuth = (user: { id: string; isAnonymous: boolean } | null): Auth => {
  return {
    api: {
      getSession: () => Promise.resolve(user ? { user, session: {} } : null),
    },
  } as unknown as Auth
}

const buildApp = (auth: Auth): Elysia => new Elysia().use(createAgentsRoutes(auth)) as unknown as Elysia

const haystackDescriptor: RemoteAgentDescriptor = {
  id: 'haystack-rag',
  name: 'RAG Chat',
  type: 'managed-acp',
  transport: 'websocket',
  url: 'wss://example.test/v1/haystack/ws?pipeline=rag',
  description: 'Retrieval-augmented chat',
  icon: null,
  isSystem: 1,
}

const customDescriptor: RemoteAgentDescriptor = {
  id: 'custom-foo',
  name: 'Custom Foo',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://example.test/foo',
  description: null,
  icon: null,
  isSystem: 0,
}

describe('GET /agents', () => {
  /** Env-var keys this suite mutates. Saved + restored to avoid cross-file leakage. */
  const envKeys = ['ENABLED_AGENTS', 'ALLOW_CUSTOM_AGENTS', 'ALLOW_ANONYMOUS_AGENT_DISCOVERY', 'AGENT_ENABLED'] as const
  let savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>>

  beforeEach(() => {
    resetAgentProvidersForTesting()
    savedEnv = {}
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    clearSettingsCache()
  })

  afterEach(() => {
    resetAgentProvidersForTesting()
    for (const key of envKeys) {
      const saved = savedEnv[key]
      if (saved === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved
      }
    }
    clearSettingsCache()
  })

  it('returns 401 when no session is present', async () => {
    const app = buildApp(buildAuth(null))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 ANONYMOUS_DISCOVERY_FORBIDDEN for anonymous users', async () => {
    const app = buildApp(buildAuth({ id: 'anon-1', isAnonymous: true }))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toEqual({ error: 'Forbidden', code: 'ANONYMOUS_DISCOVERY_FORBIDDEN' })
  })

  it('returns only anonymous-safe agents to anonymous users when anonymous discovery is allowed', async () => {
    const safe: RemoteAgentDescriptor = { ...customDescriptor, id: 'safe', anonymousSafe: true }
    registerAgentProvider({ id: 'mixed', list: () => [haystackDescriptor, safe] })
    process.env.ALLOW_ANONYMOUS_AGENT_DISCOVERY = 'true'
    clearSettingsCache()

    const app = buildApp(buildAuth({ id: 'anon-1', isAnonymous: true }))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agents).toEqual([safe])
  })

  it('still applies ENABLED_AGENTS to anonymous discovery', async () => {
    const safe: RemoteAgentDescriptor = { ...customDescriptor, id: 'safe', anonymousSafe: true }
    registerAgentProvider({ id: 'mixed', list: () => [safe] })
    process.env.ALLOW_ANONYMOUS_AGENT_DISCOVERY = 'true'
    process.env.ENABLED_AGENTS = 'other'
    clearSettingsCache()

    const app = buildApp(buildAuth({ id: 'anon-1', isAnonymous: true }))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect((await res.json()).agents).toEqual([])
  })

  it('does not narrow the list for authenticated users when anonymous discovery is allowed', async () => {
    registerAgentProvider({ id: 'haystack', list: () => [haystackDescriptor] })
    process.env.ALLOW_ANONYMOUS_AGENT_DISCOVERY = 'true'
    clearSettingsCache()

    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect((await res.json()).agents).toEqual([haystackDescriptor])
  })

  it('lists the hosted agent for registered and anonymous users when AGENT_ENABLED is set', async () => {
    registerAgentProvider(createHostedAgentProvider())
    process.env.AGENT_ENABLED = 'true'
    process.env.ALLOW_ANONYMOUS_AGENT_DISCOVERY = 'true'
    clearSettingsCache()

    for (const isAnonymous of [false, true]) {
      const app = buildApp(buildAuth({ id: 'user-1', isAnonymous }))
      const res = await app.handle(new Request('http://localhost/agents'))
      const body = await res.json()
      expect(body.agents).toHaveLength(1)
      expect(body.agents[0]).toMatchObject({ id: 'hosted-agent', type: 'managed-http', url: '/v1/agent/chat' })
    }
  })

  describe('defaultAgentId', () => {
    const fetchDiscovery = async (user: { id: string; isAnonymous: boolean }) => {
      const app = buildApp(buildAuth(user))
      return (await app.handle(new Request('http://localhost/agents'))).json()
    }

    beforeEach(() => {
      registerAgentProvider(createHostedAgentProvider())
    })

    it('names the hosted agent when it is enabled and visible', async () => {
      process.env.AGENT_ENABLED = 'true'
      clearSettingsCache()
      const body = await fetchDiscovery({ id: 'user-1', isAnonymous: false })
      expect(body.defaultAgentId).toBe('hosted-agent')
    })

    it('is omitted when the hosted agent is disabled', async () => {
      const body = await fetchDiscovery({ id: 'user-1', isAnonymous: false })
      expect('defaultAgentId' in body).toBe(false)
    })

    it('is omitted when another provider reuses the hosted agent id and AGENT_ENABLED is off', async () => {
      registerAgentProvider({ id: 'haystack', list: () => [{ ...haystackDescriptor, id: 'hosted-agent' }] })
      const body = await fetchDiscovery({ id: 'user-1', isAnonymous: false })
      expect(body.agents).toHaveLength(1)
      expect('defaultAgentId' in body).toBe(false)
    })

    it('is omitted when ENABLED_AGENTS excludes the hosted agent', async () => {
      process.env.AGENT_ENABLED = 'true'
      process.env.ENABLED_AGENTS = 'other'
      clearSettingsCache()
      const body = await fetchDiscovery({ id: 'user-1', isAnonymous: false })
      expect('defaultAgentId' in body).toBe(false)
    })

    it('is given to anonymous callers only when anonymous discovery is allowed', async () => {
      process.env.AGENT_ENABLED = 'true'
      process.env.ALLOW_ANONYMOUS_AGENT_DISCOVERY = 'true'
      clearSettingsCache()
      const body = await fetchDiscovery({ id: 'anon-1', isAnonymous: true })
      expect(body.defaultAgentId).toBe('hosted-agent')
    })
  })

  it('returns 200 with the discovery envelope for an authenticated regular user', async () => {
    registerAgentProvider({ id: 'haystack', list: () => [haystackDescriptor] })

    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      version: '1',
      agents: [haystackDescriptor],
      allowCustomAgents: true,
    })
  })

  it('filters agents by ENABLED_AGENTS when set', async () => {
    registerAgentProvider({ id: 'haystack', list: () => [haystackDescriptor, customDescriptor] })
    process.env.ENABLED_AGENTS = 'custom-foo,unknown-id'
    clearSettingsCache()

    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agents).toEqual([customDescriptor])
    expect(body.allowCustomAgents).toBe(true)
  })

  it('reflects ALLOW_CUSTOM_AGENTS=false in the response', async () => {
    process.env.ALLOW_CUSTOM_AGENTS = 'false'
    clearSettingsCache()

    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.allowCustomAgents).toBe(false)
  })

  it('concatenates descriptors from multiple providers in registration order', async () => {
    registerAgentProvider({ id: 'a', list: () => [haystackDescriptor] })
    registerAgentProvider({ id: 'b', list: () => [customDescriptor] })

    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agents).toEqual([haystackDescriptor, customDescriptor])
  })

  it('isolates failures: a throwing provider does not poison other providers', async () => {
    registerAgentProvider({
      id: 'broken',
      list: () => {
        throw new Error('boom')
      },
    })
    registerAgentProvider({ id: 'ok', list: () => [customDescriptor] })

    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agents).toEqual([customDescriptor])
  })
})
