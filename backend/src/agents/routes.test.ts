import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { clearSettingsCache } from '@/config/settings'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import type { AgentDescriptor, AgentProvider } from './types'

// We test the route logic by calling the Elysia app directly via .handle()
import { createAgentsRoutes } from './routes'

const makeProvider = (agents: AgentDescriptor[]): AgentProvider => ({
  getAgents: async () => agents,
})

const agent1: AgentDescriptor = { id: 'a1', name: 'Agent 1', type: 'remote', transport: 'websocket', url: 'wss://a1' }
const agent2: AgentDescriptor = { id: 'a2', name: 'Agent 2', type: 'built-in', transport: 'in-process' }
const agent3: AgentDescriptor = { id: 'a3', name: 'Agent 3', type: 'remote', transport: 'websocket', url: 'wss://a3' }

const ENV_KEYS = ['ENABLED_AGENTS'] as const
let savedEnv: Partial<Record<string, string | undefined>>
let consoleSpies: ConsoleSpies

beforeAll(() => {
  consoleSpies = setupConsoleSpy()
})

afterAll(() => {
  consoleSpies.restore()
})

beforeEach(() => {
  clearSettingsCache()
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key]
    } else {
      delete process.env[key]
    }
  }
  clearSettingsCache()
})

describe('Agent routes', () => {
  it('returns empty array when no providers are registered', async () => {
    const app = createAgentsRoutes([])
    const res = await app.handle(new Request('http://localhost/agents'))
    const json = (await res.json()) as { agents: AgentDescriptor[] }
    expect(json.agents).toEqual([])
  })

  it('merges results from multiple providers', async () => {
    const app = createAgentsRoutes([makeProvider([agent1]), makeProvider([agent2, agent3])])
    const res = await app.handle(new Request('http://localhost/agents'))
    const json = (await res.json()) as { agents: AgentDescriptor[] }
    expect(json.agents).toHaveLength(3)
    expect(json.agents.map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('filters by type query parameter', async () => {
    const app = createAgentsRoutes([makeProvider([agent1, agent2, agent3])])
    const res = await app.handle(new Request('http://localhost/agents?type=remote'))
    const json = (await res.json()) as { agents: AgentDescriptor[] }
    expect(json.agents).toHaveLength(2)
    expect(json.agents.every((a) => a.type === 'remote')).toBe(true)
  })

  it('filters by id query parameter', async () => {
    const app = createAgentsRoutes([makeProvider([agent1, agent2, agent3])])
    const res = await app.handle(new Request('http://localhost/agents?id=a2'))
    const json = (await res.json()) as { agents: AgentDescriptor[] }
    expect(json.agents).toHaveLength(1)
    expect(json.agents[0].id).toBe('a2')
  })

  it('filters by enabledAgents setting', async () => {
    process.env.ENABLED_AGENTS = 'a1,a3'
    clearSettingsCache()

    const app = createAgentsRoutes([makeProvider([agent1, agent2, agent3])])
    const res = await app.handle(new Request('http://localhost/agents'))
    const json = (await res.json()) as { agents: AgentDescriptor[] }
    expect(json.agents).toHaveLength(2)
    expect(json.agents.map((a) => a.id)).toEqual(['a1', 'a3'])
  })

  it('returns all agents when enabledAgents is empty', async () => {
    delete process.env.ENABLED_AGENTS
    clearSettingsCache()

    const app = createAgentsRoutes([makeProvider([agent1, agent2])])
    const res = await app.handle(new Request('http://localhost/agents'))
    const json = (await res.json()) as { agents: AgentDescriptor[] }
    expect(json.agents).toHaveLength(2)
  })

  it('returns fulfilled provider agents when another provider rejects', async () => {
    consoleSpies.error.mockClear()
    const rejectingProvider: AgentProvider = {
      getAgents: async () => {
        throw new Error('boom')
      },
    }
    const app = createAgentsRoutes([rejectingProvider, makeProvider([agent1, agent2])])
    const res = await app.handle(new Request('http://localhost/agents'))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { agents: AgentDescriptor[] }
    expect(json.agents.map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(consoleSpies.error).toHaveBeenCalled()
  })
})
