import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { agentsTable } from '@/db/tables'
import { v7 as uuidv7 } from 'uuid'
import { mergeRegistryWithInstalled, filterAgents, sortAgents } from './use-agent-registry'
import type { RegistryEntry } from '@/acp/registry'
import { act, cleanup } from '@testing-library/react'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import '@testing-library/jest-dom'
import AgentsSettingsPage from './index'
import { getClock } from '@/testing-library'

// Focus on testing the data logic since the page component requires
// complex provider setup (PowerSync, React Query, Router).
// UI rendering is tested via agent-card.test.tsx and add-custom-agent-dialog.test.tsx.

const mockRegistry: RegistryEntry[] = [
  {
    id: 'claude-acp',
    name: 'Claude Agent',
    version: '0.24.2',
    description: 'Claude Code ACP adapter by Anthropic',
    authors: ['Anthropic'],
    license: 'MIT',
    distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.24.2' } },
  },
  {
    id: 'goose',
    name: 'goose',
    version: '1.29.0',
    description: 'AI coding agent by Block',
    authors: ['Block'],
    license: 'Apache-2.0',
    distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/goose.tar.gz', cmd: './goose' } } },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    version: '0.35.3',
    description: 'Google Gemini CLI agent',
    authors: ['Google'],
    license: 'Apache-2.0',
    distribution: { npx: { package: '@anthropic/gemini-agent@0.35.3' } },
  },
]

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Agents Settings Page — data integration', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('merge + filter + sort pipeline', () => {
    it('shows all registry agents when nothing installed', () => {
      const merged = mergeRegistryWithInstalled(mockRegistry, [])
      expect(merged).toHaveLength(3)
      expect(merged.every((a) => !a.isInstalled)).toBe(true)
    })

    it('marks installed agents correctly from DB data', async () => {
      const db = getDb()
      await db.insert(agentsTable).values({
        id: 'agent-registry-claude-acp',
        name: 'Claude Agent',
        type: 'local',
        transport: 'stdio',
        enabled: 1,
        registryId: 'claude-acp',
        installedVersion: '0.24.2',
        registryVersion: '0.24.2',
        distributionType: 'npx',
        installPath: '/mock/agents/claude-acp',
      })

      const installed = await db.select().from(agentsTable).all()
      const merged = mergeRegistryWithInstalled(mockRegistry, installed as any)

      const claude = merged.find((a) => a.registryId === 'claude-acp')
      expect(claude?.isInstalled).toBe(true)
      expect(claude?.enabled).toBe(true)
      expect(claude?.installedVersion).toBe('0.24.2')

      const goose = merged.find((a) => a.registryId === 'goose')
      expect(goose?.isInstalled).toBe(false)
    })

    it('detects update available', async () => {
      const db = getDb()
      await db.insert(agentsTable).values({
        id: 'agent-registry-claude-acp',
        name: 'Claude Agent',
        type: 'local',
        transport: 'stdio',
        enabled: 1,
        registryId: 'claude-acp',
        installedVersion: '0.22.0',
        registryVersion: '0.24.2',
      })

      const installed = await db.select().from(agentsTable).all()
      const merged = mergeRegistryWithInstalled(mockRegistry, installed as any)
      const claude = merged.find((a) => a.registryId === 'claude-acp')
      expect(claude?.updateAvailable).toBe(true)
    })

    it('includes custom agents from DB', async () => {
      const db = getDb()
      await db.insert(agentsTable).values({
        id: uuidv7(),
        name: 'My Custom Agent',
        type: 'local',
        transport: 'stdio',
        enabled: 1,
        distributionType: 'custom',
        command: '/usr/local/bin/my-agent',
      })

      const installed = await db.select().from(agentsTable).all()
      const merged = mergeRegistryWithInstalled(mockRegistry, installed as any)
      expect(merged).toHaveLength(4) // 3 registry + 1 custom
      const custom = merged.find((a) => a.isCustom)
      expect(custom?.name).toBe('My Custom Agent')
    })

    it('search filters by name case-insensitive', () => {
      const merged = mergeRegistryWithInstalled(mockRegistry, [])
      const filtered = filterAgents(merged, 'CLAUDE')
      expect(filtered).toHaveLength(1)
      expect(filtered[0].name).toBe('Claude Agent')
    })

    it('search filters by description', () => {
      const merged = mergeRegistryWithInstalled(mockRegistry, [])
      const filtered = filterAgents(merged, 'google')
      expect(filtered).toHaveLength(1)
      expect(filtered[0].name).toBe('Gemini CLI')
    })

    it('search returns empty for no matches', () => {
      const merged = mergeRegistryWithInstalled(mockRegistry, [])
      const filtered = filterAgents(merged, 'zzzzz')
      expect(filtered).toHaveLength(0)
    })

    it('sorts installed agents first, then alphabetical', async () => {
      const db = getDb()
      await db.insert(agentsTable).values({
        id: 'agent-registry-goose',
        name: 'goose',
        type: 'local',
        transport: 'stdio',
        enabled: 1,
        registryId: 'goose',
        installedVersion: '1.29.0',
      })

      const installed = await db.select().from(agentsTable).all()
      const merged = mergeRegistryWithInstalled(mockRegistry, installed as any)
      const sorted = sortAgents(merged)

      // goose (installed) should be first
      expect(sorted[0].name).toBe('goose')
      expect(sorted[0].isInstalled).toBe(true)
      // Then alphabetical: Claude Agent, Gemini CLI
      expect(sorted[1].name).toBe('Claude Agent')
      expect(sorted[2].name).toBe('Gemini CLI')
    })

    it('disabled installed agents are still in sorted order', async () => {
      const db = getDb()
      await db.insert(agentsTable).values({
        id: 'agent-registry-claude-acp',
        name: 'Claude Agent',
        type: 'local',
        transport: 'stdio',
        enabled: 0,
        registryId: 'claude-acp',
        installedVersion: '0.24.2',
      })

      const installed = await db.select().from(agentsTable).all()
      const merged = mergeRegistryWithInstalled(mockRegistry, installed as any)
      const sorted = sortAgents(merged)

      // Installed (even if disabled) first
      expect(sorted[0].name).toBe('Claude Agent')
      expect(sorted[0].isInstalled).toBe(true)
      expect(sorted[0].enabled).toBe(false)
    })
  })
})

describe('AgentsSettingsPage — allowCustomAgents gate', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    fetchSpy?.mockRestore()
    cleanup()
  })

  const makeRegistryResponse = (allowCustomAgents: boolean) =>
    new Response(JSON.stringify({ version: '1.0.0', agents: [], extensions: [], allowCustomAgents }), {
      headers: { 'Content-Type': 'application/json' },
    })

  const getAddButton = () => document.querySelector('[data-slot="dialog-trigger"]')

  it('hides the Add button when allowCustomAgents is false', async () => {
    fetchSpy = spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValue(makeRegistryResponse(false))

    renderWithReactivity(<AgentsSettingsPage />, { tables: ['agents'] })

    await act(async () => {
      getClock().tick(100)
      await getClock().runAllAsync()
    })

    expect(getAddButton()).toBeNull()
  })

  it('shows the Add button when allowCustomAgents is true', async () => {
    fetchSpy = spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValue(makeRegistryResponse(true))

    renderWithReactivity(<AgentsSettingsPage />, { tables: ['agents'] })

    await waitForElement(() => getAddButton() as HTMLElement | null)

    expect(getAddButton()).toBeTruthy()
  })
})
