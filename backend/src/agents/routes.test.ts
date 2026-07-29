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
import { schemaVersionMismatch, type AgentDescriptor } from '@shared/agent-descriptors'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
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
  const envKeys = ['ENABLED_AGENTS', 'ALLOW_CUSTOM_AGENTS'] as const
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

describe('agent deploy endpoints', () => {
  const envKeys = ['AGENT_DEPLOY', 'ENABLED_AGENTS'] as const
  let savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>>

  const descriptor: AgentDescriptor = {
    id: 'haystack',
    provider: 'haystack',
    name: 'Haystack',
    description: null,
    icon: null,
    schemaVersion: 3,
    action: 'deploy',
    steps: [
      { id: 'basics', title: 'Basics', fields: [{ key: 'name', label: 'Name', widget: 'text', required: true }] },
    ],
  }

  /** A deployable provider whose verbs echo their inputs so tests can assert dispatch. */
  const registerDeployable = () =>
    registerAgentProvider({
      id: 'haystack',
      list: () => [],
      catalog: () => [descriptor],
      deploy: (spec) => Promise.resolve({ deploymentId: `haystack:tb-${String(spec.name)}`, status: 'pending' }),
      status: (ref) => Promise.resolve({ deploymentId: `haystack:${ref}`, status: 'running', connection: null }),
    })

  const post = (app: Elysia, path: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  beforeEach(() => {
    resetAgentProvidersForTesting()
    savedEnv = {}
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.AGENT_DEPLOY = 'true'
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

  it('GET /catalog returns the descriptors when the flag is on', async () => {
    registerDeployable()
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents/catalog'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('1')
    expect(body.descriptors.map((d: AgentDescriptor) => d.id)).toEqual(['haystack'])
  })

  it('GET /catalog returns 404 when the agentDeploy flag is off', async () => {
    delete process.env.AGENT_DEPLOY
    clearSettingsCache()
    registerDeployable()
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents/catalog'))
    expect(res.status).toBe(404)
  })

  it('GET /catalog returns 403 for anonymous users', async () => {
    const app = buildApp(buildAuth({ id: 'anon-1', isAnonymous: true }))
    const res = await app.handle(new Request('http://localhost/agents/catalog'))
    expect(res.status).toBe(403)
  })

  it('POST /deploy dispatches a valid spec to the provider', async () => {
    registerDeployable()
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await post(app, '/agents/deploy', { descriptorId: 'haystack', schemaVersion: 3, spec: { name: 'Bot' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ deploymentId: 'haystack:tb-Bot', status: 'pending' })
  })

  it('POST /deploy returns 409 on a stale schema version', async () => {
    registerDeployable()
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await post(app, '/agents/deploy', { descriptorId: 'haystack', schemaVersion: 2, spec: { name: 'Bot' } })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe(schemaVersionMismatch)
  })

  it('POST /deploy returns 400 when the spec fails re-validation', async () => {
    registerDeployable()
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    // `name` is required by the descriptor but missing here.
    const res = await post(app, '/agents/deploy', { descriptorId: 'haystack', schemaVersion: 3, spec: {} })
    expect(res.status).toBe(400)
  })

  it('POST /deploy returns 404 for an unknown descriptor', async () => {
    registerDeployable()
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await post(app, '/agents/deploy', { descriptorId: 'ghost', schemaVersion: 3, spec: { name: 'x' } })
    expect(res.status).toBe(404)
  })

  it('GET /deployments/:id returns live status from the provider', async () => {
    registerDeployable()
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents/deployments/haystack:tb-bot'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ deploymentId: 'haystack:tb-bot', status: 'running', connection: null })
  })

  it('GET /deployments/:id returns 400 for a malformed id', async () => {
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents/deployments/nocolon'))
    expect(res.status).toBe(400)
  })

  it('GET /deployments/:id returns 404 for an unknown provider', async () => {
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }))
    const res = await app.handle(new Request('http://localhost/agents/deployments/ghost:ref'))
    expect(res.status).toBe(404)
  })
})
