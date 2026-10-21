/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Database } from 'bun:sqlite'
import { expect, it, spyOn } from 'bun:test'
import type { CommonPowerSyncDatabase } from '@powersync/common'
import { AppSchema } from '@/db/powersync/schema'
import { searchEntities } from './registry'
import { ensureSearchIndex } from './fts-setup'
import { useSearchIndex } from './use-search-index'
import { useSearch } from './use-search'
import { PowerSyncContext } from '@powersync/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { getClock } from '@/testing-library'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from '@/db/schema'
import * as syncState from '@/db/powersync/sync-state'
import { createProjectSearchTool } from '@/projects/project-search-tool'

/** Exercises real SQLite transactions and FTS using the PowerSync transaction surface. */
const fixture = () => {
  const sqlite = new Database(':memory:')
  const transaction = {
    execute: async (sql: string) => sqlite.run(sql),
    getAll: async <T>(sql: string, parameters: string[] = []) => sqlite.query(sql).all(...parameters) as T[],
  }
  const database = {
    writeTransaction: async (callback: (tx: typeof transaction) => Promise<void>) => {
      sqlite.run('BEGIN IMMEDIATE')
      try {
        await callback(transaction)
        sqlite.run('COMMIT')
      } catch (error) {
        sqlite.run('ROLLBACK')
        throw error
      }
    },
  } as unknown as CommonPowerSyncDatabase
  const createTables = () => {
    for (const entity of searchEntities) {
      const table = AppSchema.tables.find((candidate) => candidate.name === entity.tableName)!
      sqlite.run(`CREATE TABLE IF NOT EXISTS ${table.internalName} (id TEXT PRIMARY KEY, data TEXT)`)
    }
  }
  return { sqlite, database, createTables }
}

it('prepares once for concurrent callers and backfills rows written before first search', async () => {
  const { sqlite, database, createTables } = fixture()
  try {
    createTables()
    const table = AppSchema.tables.find((candidate) => candidate.name === 'models')!
    sqlite.run(`INSERT INTO ${table.internalName} VALUES (?, ?)`, [
      'model',
      JSON.stringify({ name: 'Delayed index', deleted_at: null }),
    ])
    const first = ensureSearchIndex(database)
    expect(ensureSearchIndex(database)).toBe(first)
    await first
    expect(sqlite.query("SELECT id FROM search_index WHERE search_index MATCH 'Delayed'").all()).toEqual([
      { id: 'model' },
    ])
    await ensureSearchIndex(database)
    expect(sqlite.query('SELECT id FROM search_index').all()).toHaveLength(1)
    // Dropped triggers still self-heal on a subsequent preparation pass.
    sqlite.run('DROP TRIGGER search_index_ai_model')
    await ensureSearchIndex(database)
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name = 'search_index_ai_model'").all()).toHaveLength(1)
  } finally {
    sqlite.close()
  }
})

it('prepares a fresh index when a project search tool runs before the search palette', async () => {
  const { sqlite, database, createTables } = fixture()
  const getPowerSync = spyOn(syncState, 'getPowerSyncInstance').mockReturnValue(
    database as ReturnType<typeof syncState.getPowerSyncInstance>,
  )
  try {
    createTables()
    const table = AppSchema.tables.find((candidate) => candidate.name === 'chat_messages')!
    sqlite.run(`INSERT INTO ${table.internalName} VALUES (?, ?)`, [
      'message',
      JSON.stringify({ chat_thread_id: 'sibling', content: 'Pricing is $29 per seat', deleted_at: null }),
    ])
    const db = drizzle(
      async (statement, parameters = []) => ({ rows: sqlite.query(statement).values(...parameters) }),
      {
        schema,
      },
    )
    const tool = createProjectSearchTool({
      db,
      projectName: 'Launch',
      threadIds: ['sibling'],
      titleByThreadId: new Map([['sibling', 'Pricing plan']]),
    })
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name = 'search_index'").all()).toHaveLength(0)
    const output = await tool.execute!({ query: 'Pricing' }, { toolCallId: 'test', messages: [] })
    expect(output).toContain('From "Pricing plan"')
    expect(output).toContain('Pricing is $29 per seat')
  } finally {
    getPowerSync.mockRestore()
    sqlite.close()
  }
})

it('retries a failed preparation after reopening and reports pending while it retries', async () => {
  const { sqlite, database, createTables } = fixture()
  const retry = Promise.withResolvers<void>()
  let attempts = 0
  const powerSync = {
    writeTransaction: async (callback: Parameters<typeof database.writeTransaction>[0]) => {
      attempts += 1
      if (attempts > 1) {
        await retry.promise
      }
      return database.writeTransaction(callback)
    },
  } as unknown as CommonPowerSyncDatabase
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(PowerSyncContext.Provider, { value: powerSync }, children)
  const { result, rerender, unmount } = renderHook(({ enabled }) => useSearchIndex(enabled), {
    initialProps: { enabled: true },
    wrapper,
  })
  try {
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(result.current).toBe('failed')
    createTables()
    rerender({ enabled: false })
    rerender({ enabled: true })
    expect(result.current).toBe('pending')
    await act(async () => {
      retry.resolve()
      await getClock().runAllAsync()
    })
    expect(result.current).toBe('ready')
    expect(attempts).toBe(2)
  } finally {
    unmount()
    sqlite.close()
  }
})

it('rolls back an incomplete rebuild and allows another attempt', async () => {
  const { sqlite, database, createTables } = fixture()
  try {
    await expect(ensureSearchIndex(database)).rejects.toThrow()
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name = 'search_index'").all()).toHaveLength(0)
    createTables()
    await ensureSearchIndex(database)
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name = 'search_index'").all()).toHaveLength(1)
  } finally {
    sqlite.close()
  }
})

it('does not inspect the search SQL before first-use index preparation completes', async () => {
  const { sqlite, database, createTables } = fixture()
  const preparation = Promise.withResolvers<void>()
  const inspectionErrors: unknown[] = []
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  let preparationCount = 0
  const powerSync = {
    writeTransaction: async (callback: Parameters<typeof database.writeTransaction>[0]) => {
      preparationCount += 1
      await preparation.promise
      return database.writeTransaction(callback)
    },
    resolveTables: async (sql: string, parameters: string[] = []) => {
      try {
        using statement = sqlite.prepare(`EXPLAIN ${sql}`)
        statement.all(...parameters)
      } catch (error) {
        inspectionErrors.push(error)
        throw error
      }
      return []
    },
    getAll: async <T>(sql: string, parameters: string[] = []) => {
      using statement = sqlite.prepare(sql)
      return statement.all(...parameters) as T[]
    },
    registerListener: () => () => {},
  } as unknown as CommonPowerSyncDatabase
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      PowerSyncContext.Provider,
      { value: powerSync },
      createElement(QueryClientProvider, { client }, children),
    )
  createTables()
  const table = AppSchema.tables.find((candidate) => candidate.name === 'models')!
  sqlite.run(`INSERT INTO ${table.internalName} VALUES (?, ?)`, [
    'model',
    JSON.stringify({ name: 'Delayed index', deleted_at: null }),
  ])
  const { result, rerender, unmount } = renderHook(({ query }) => useSearch(query), {
    initialProps: { query: '' },
    wrapper,
  })
  try {
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(inspectionErrors).toEqual([])
    rerender({ query: 'Delayed' })
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(result.current.isLoading).toBe(true)
    expect(inspectionErrors).toEqual([])
    await act(async () => {
      preparation.resolve()
      await getClock().runAllAsync()
    })
    expect(result.current.isError).toBe(false)
    expect(result.current.results.map(({ id }) => id)).toEqual(['model'])
    rerender({ query: 'Delaye' })
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(preparationCount).toBe(1)

    rerender({ query: '' })
    sqlite.run('DROP TABLE search_index')
    rerender({ query: 'Delayed' })
    expect(result.current.isLoading).toBe(true)
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(preparationCount).toBe(2)
    expect(inspectionErrors).toEqual([])
    expect(result.current.isError).toBe(false)
    expect(result.current.results.map(({ id }) => id)).toEqual(['model'])
  } finally {
    unmount()
    client.clear()
    sqlite.close()
  }
})
