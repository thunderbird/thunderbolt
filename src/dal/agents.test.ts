/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { agentsSystemTable, agentsTable } from '@/db/tables'
import { builtInAgent } from '@/defaults/agents'
import { HttpError, type HttpClient, type ResponsePromise } from '@/lib/http'
import { refreshSystemAgents } from '@/db/seeding/seed-agents'
import { clearAdapterCache, getOrConnectAdapter } from '@/acp/adapter-cache'
import type { AgentAdapter } from '@/types/acp'
import type { AgentDiscoveryResponse } from '@shared/acp-types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { composeAllAgents, createAgent, deleteAgent, getAgentSecrets, setAgentSecrets, updateAgent } from './agents'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'
import type { Agent } from '@/types/acp'

/** Seed the global adapter cache with a fake connection for `agentId` and hand
 *  back a disconnect spy so a test can assert the DAL disposed it. */
const seedCachedAdapter = async (agentId: string) => {
  let disconnects = 0
  const adapter: AgentAdapter = {
    agent: { id: agentId } as Agent,
    capabilities: null,
    fetch: async () => new Response('ok'),
    disconnect: () => {
      disconnects++
    },
  }
  await getOrConnectAdapter(
    { id: agentId } as Agent,
    { httpClient: {} as HttpClient, getProxyFetch: () => null as never },
    {
      connectToAgent: (async () => adapter) as never,
    },
  )
  return { disconnectCount: () => disconnects }
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
  clearAdapterCache()
})

/** Build a stub HttpClient where `get` resolves to a JSON payload or throws.
 *  Real HttpClient eagerly fires the request, so the base promise rejects
 *  even when callers only consume `.json()`. To match that, we attach a no-op
 *  `.catch` to the base so rejections don't surface as unhandled. */
const makeHttpClient = (impl: () => unknown): HttpClient => {
  const invoke = <T>(): Promise<T> => Promise.resolve().then(() => impl() as Promise<T>)
  const get = (): ResponsePromise => {
    const base = invoke<unknown>().then((data) => new Response(JSON.stringify(data))) as ResponsePromise
    base.catch(() => {})
    base.json = <T>(): Promise<T> => invoke<T>()
    base.text = () => invoke<unknown>().then((d) => JSON.stringify(d))
    return base
  }
  return {
    get,
    post: get,
    delete: get,
  }
}

const httpErrorOf = (status: number): HttpError => new HttpError(new Response(null, { status }))

describe('agents DAL', () => {
  describe('createAgent', () => {
    it('inserts a custom agent with the caller-supplied userId', async () => {
      const db = getDb()
      await createAgent(db, {
        id: 'agent-1',
        name: 'Custom Remote',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://example.test/ws',
        userId: 'user-42',
      })

      const row = await db.select().from(agentsTable).get()
      expect(row?.id).toBe('agent-1')
      expect(row?.userId).toBe('user-42')
      expect(row?.type).toBe('remote-acp')
      expect(row?.transport).toBe('websocket')
      expect(row?.enabled).toBe(1)
      expect(row?.deletedAt).toBeNull()
    })

    it('defaults enabled = 1 when omitted', async () => {
      await createAgent(getDb(), {
        id: 'agent-default',
        name: 'Defaults',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://example.test/acp',
        userId: 'u1',
      })
      const row = await getDb().select().from(agentsTable).get()
      expect(row?.enabled).toBe(1)
    })
  })

  describe('updateAgent', () => {
    it('patches a custom agent in place', async () => {
      await createAgent(getDb(), {
        id: 'a1',
        name: 'Original',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://old/ws',
        userId: 'u1',
      })

      await updateAgent(getDb(), 'a1', { name: 'Renamed', enabled: 0 })

      const row = await getDb().select().from(agentsTable).get()
      expect(row?.name).toBe('Renamed')
      expect(row?.enabled).toBe(0)
    })

    it('refuses to edit the built-in agent', async () => {
      await expect(updateAgent(getDb(), builtInAgent.id, { name: 'nope' })).rejects.toThrow(/built-in/)
    })

    it('no-ops on an empty patch (does not touch DB)', async () => {
      await createAgent(getDb(), {
        id: 'a2',
        name: 'Untouched',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://x',
        userId: 'u1',
      })
      await updateAgent(getDb(), 'a2', {})
      const row = await getDb().select().from(agentsTable).get()
      expect(row?.name).toBe('Untouched')
    })

    it('disposes the warm ACP connection when the wire identity (url) changes', async () => {
      await createAgent(getDb(), {
        id: 'a-url',
        name: 'Wired',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://old/ws',
        userId: 'u1',
      })
      const cached = await seedCachedAdapter('a-url')

      await updateAgent(getDb(), 'a-url', { url: 'wss://new/ws' })

      expect(cached.disconnectCount()).toBe(1)
    })

    it('does NOT dispose the connection on a non-wire patch (rename only)', async () => {
      await createAgent(getDb(), {
        id: 'a-name',
        name: 'Before',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://keep/ws',
        userId: 'u1',
      })
      const cached = await seedCachedAdapter('a-name')

      await updateAgent(getDb(), 'a-name', { name: 'After' })

      expect(cached.disconnectCount()).toBe(0)
    })
  })

  describe('deleteAgent', () => {
    it('soft-deletes by stamping deletedAt; does not hard-delete', async () => {
      await createAgent(getDb(), {
        id: 'a-del',
        name: 'Doomed',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://x',
        userId: 'u1',
      })

      await deleteAgent(getDb(), 'a-del')

      const row = await getDb().select().from(agentsTable).get()
      expect(row).toBeDefined()
      expect(row?.deletedAt).not.toBeNull()
    })

    it('refuses to delete the built-in agent', async () => {
      await expect(deleteAgent(getDb(), builtInAgent.id)).rejects.toThrow(/built-in/)
    })

    it('disposes the agent warm ACP connection on delete', async () => {
      await createAgent(getDb(), {
        id: 'a-disp',
        name: 'Doomed',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://x',
        userId: 'u1',
      })
      const cached = await seedCachedAdapter('a-disp')

      await deleteAgent(getDb(), 'a-disp')

      expect(cached.disconnectCount()).toBe(1)
    })
  })

  describe('composeAllAgents', () => {
    const customAgent = (id: string, name: string): Agent => ({
      id,
      name,
      type: 'remote-acp',
      transport: 'websocket',
      url: `wss://${id}`,
      description: null,
      icon: null,
      isSystem: 0,
      enabled: 1,
      deletedAt: null,
      userId: 'u1',
    })
    const systemAgent = (id: string, name: string): Agent => ({
      id,
      name,
      type: 'managed-acp',
      transport: 'websocket',
      url: `wss://${id}`,
      description: null,
      icon: null,
      isSystem: 1,
      enabled: 1,
      deletedAt: null,
      userId: null,
    })

    it('returns built-in first, then system, then customs', () => {
      const result = composeAllAgents(
        [systemAgent('sys-a', 'Alpha System'), systemAgent('sys-z', 'Zulu System')],
        [customAgent('c-a', 'Alpha Custom'), customAgent('c-z', 'Zulu Custom')],
      )

      expect(result.map((a) => a.id)).toEqual([builtInAgent.id, 'sys-a', 'sys-z', 'c-a', 'c-z'])
    })

    it('returns just built-in when no system or customs', () => {
      const result = composeAllAgents([], [])
      expect(result).toEqual([builtInAgent])
    })

    it('includes built-in when includeBuiltIn is true', () => {
      const result = composeAllAgents([systemAgent('sys-a', 'Alpha System')], [], { includeBuiltIn: true })
      expect(result.map((a) => a.id)).toEqual([builtInAgent.id, 'sys-a'])
    })

    it('omits built-in entirely when includeBuiltIn is false', () => {
      const result = composeAllAgents([systemAgent('sys-a', 'Alpha System')], [customAgent('c-a', 'Alpha Custom')], {
        includeBuiltIn: false,
      })
      expect(result.map((a) => a.id)).toEqual(['sys-a', 'c-a'])
    })

    it('returns an empty list when built-in disabled and there are no other agents', () => {
      expect(composeAllAgents([], [], { includeBuiltIn: false })).toEqual([])
    })
  })

  describe('agent secrets', () => {
    it('round-trips apiKey and authMethod via setAgentSecrets/getAgentSecrets', async () => {
      await setAgentSecrets(getDb(), 'agent-x', { apiKey: 'sk-test', authMethod: 'bearer' })

      const round1 = await getAgentSecrets(getDb(), 'agent-x')
      expect(round1).toEqual({ apiKey: 'sk-test', authMethod: 'bearer' })

      // Partial update preserves the other column.
      await setAgentSecrets(getDb(), 'agent-x', { apiKey: 'sk-rotated' })

      const round2 = await getAgentSecrets(getDb(), 'agent-x')
      expect(round2).toEqual({ apiKey: 'sk-rotated', authMethod: 'bearer' })
    })

    it('returns null when no secrets row exists for the agent', async () => {
      const result = await getAgentSecrets(getDb(), 'unknown-agent')
      expect(result).toBeNull()
    })

    it('inserts a fresh row when none exists', async () => {
      await setAgentSecrets(getDb(), 'new-agent', { authMethod: 'oauth' })
      const result = await getAgentSecrets(getDb(), 'new-agent')
      expect(result).toEqual({ apiKey: null, authMethod: 'oauth' })
    })
  })

  describe('refreshSystemAgents', () => {
    const baseResponse: AgentDiscoveryResponse = {
      version: '1',
      agents: [
        {
          id: 'haystack-rag',
          name: 'RAG Chat',
          type: 'managed-acp',
          transport: 'websocket',
          url: 'wss://thunderbolt.example/v1/haystack/ws?pipeline=rag',
          description: 'Retrieval-augmented chat',
          icon: null,
          isSystem: 1,
        },
      ],
      allowCustomAgents: true,
    }

    it('upserts returned agents and stamps fetchedAt on 200', async () => {
      const client = makeHttpClient(async () => baseResponse)

      const result = await refreshSystemAgents(getDb(), 'https://api.example', client)
      expect(result).toEqual({ refreshed: true })

      const rows = await getDb().select().from(agentsSystemTable).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe('haystack-rag')
      expect(rows[0]?.name).toBe('RAG Chat')
      expect(rows[0]?.fetchedAt).toBeTruthy()
    })

    it('removes local rows that disappear from the discovery response', async () => {
      const fetchedAt = new Date().toISOString()
      await getDb().insert(agentsSystemTable).values({
        id: 'legacy',
        name: 'Legacy',
        type: 'managed-acp',
        transport: 'websocket',
        url: 'wss://legacy',
        description: null,
        icon: null,
        fetchedAt,
      })

      const client = makeHttpClient(async () => baseResponse)
      await refreshSystemAgents(getDb(), 'https://api.example', client)

      const ids = (await getDb().select().from(agentsSystemTable).all()).map((r) => r.id)
      expect(ids).toEqual(['haystack-rag'])
    })

    it('skips remote-acp entries in the response (system table is managed-acp only)', async () => {
      const response: AgentDiscoveryResponse = {
        version: '1',
        agents: [
          {
            id: 'remote-only',
            name: 'Remote',
            type: 'remote-acp',
            transport: 'websocket',
            url: 'wss://x',
            description: null,
            icon: null,
            isSystem: 0,
          },
        ],
        allowCustomAgents: true,
      }
      const client = makeHttpClient(async () => response)

      const result = await refreshSystemAgents(getDb(), 'https://api.example', client)
      expect(result).toEqual({ refreshed: true })
      const rows = await getDb().select().from(agentsSystemTable).all()
      expect(rows).toEqual([])
    })

    it('clears agents_system on 403 (anonymous user)', async () => {
      const fetchedAt = new Date().toISOString()
      await getDb().insert(agentsSystemTable).values({
        id: 'stale',
        name: 'Stale',
        type: 'managed-acp',
        transport: 'websocket',
        url: 'wss://stale',
        description: null,
        icon: null,
        fetchedAt,
      })

      const client = makeHttpClient(async () => {
        throw httpErrorOf(403)
      })

      const result = await refreshSystemAgents(getDb(), 'https://api.example', client)
      expect(result).toEqual({ refreshed: false, reason: 'unauthenticated' })

      const rows = await getDb().select().from(agentsSystemTable).all()
      expect(rows).toEqual([])
    })

    it('clears agents_system on 401 (unauthenticated)', async () => {
      const fetchedAt = new Date().toISOString()
      await getDb().insert(agentsSystemTable).values({
        id: 'stale',
        name: 'Stale',
        type: 'managed-acp',
        transport: 'websocket',
        url: 'wss://stale',
        description: null,
        icon: null,
        fetchedAt,
      })

      const client = makeHttpClient(async () => {
        throw httpErrorOf(401)
      })

      const result = await refreshSystemAgents(getDb(), 'https://api.example', client)
      expect(result).toEqual({ refreshed: false, reason: 'unauthenticated' })
      const rows = await getDb().select().from(agentsSystemTable).all()
      expect(rows).toEqual([])
    })

    it('preserves existing rows on network error', async () => {
      const fetchedAt = new Date().toISOString()
      await getDb().insert(agentsSystemTable).values({
        id: 'cached',
        name: 'Cached',
        type: 'managed-acp',
        transport: 'websocket',
        url: 'wss://cached',
        description: null,
        icon: null,
        fetchedAt,
      })

      const client = makeHttpClient(async () => {
        throw new TypeError('Network down')
      })

      const result = await refreshSystemAgents(getDb(), 'https://api.example', client)
      expect(result).toEqual({ refreshed: false, reason: 'network' })

      const rows = await getDb().select().from(agentsSystemTable).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe('cached')
    })

    it('preserves existing rows on 5xx', async () => {
      const fetchedAt = new Date().toISOString()
      await getDb().insert(agentsSystemTable).values({
        id: 'cached',
        name: 'Cached',
        type: 'managed-acp',
        transport: 'websocket',
        url: 'wss://cached',
        description: null,
        icon: null,
        fetchedAt,
      })

      const client = makeHttpClient(async () => {
        throw httpErrorOf(503)
      })

      const result = await refreshSystemAgents(getDb(), 'https://api.example', client)
      expect(result).toEqual({ refreshed: false, reason: 'network' })

      const rows = await getDb().select().from(agentsSystemTable).all()
      expect(rows).toHaveLength(1)
    })
  })
})
