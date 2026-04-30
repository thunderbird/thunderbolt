/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Web Worker for wa-sqlite database operations
 * This worker handles all SQLite operations in a separate thread
 */

// Suppress console output in test environments (worker has separate console from main thread)
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  console.error = () => {}
  console.warn = () => {}
  console.info = () => {}
}

import * as SQLite from '@journeyapps/wa-sqlite'
import SQLiteESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs'
// @ts-expect-error - OPFSCoopSyncVFS exists but TypeScript definitions are incomplete
import { OPFSCoopSyncVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js'

type WorkerRequest = {
  id: number
  method: 'init' | 'exec' | 'close'
  params?: {
    filename?: string
    sql?: string
    params?: unknown[]
    method?: 'get' | 'all' | 'values' | 'run'
  }
}

type WorkerResponse = {
  id: number
  result?: {
    rows?: unknown[] | unknown
    success?: boolean
  }
  error?: string
}

type SQLiteAPI = {
  open_v2: (filename: string, flags: number, vfsName?: string) => Promise<number>
  close: (db: number) => Promise<number>
  statements: (db: number, sql: string) => AsyncIterable<number>
  bind_collection: (stmt: number, params: unknown[]) => void
  step: (stmt: number) => Promise<number>
  row: (stmt: number) => unknown[]
  vfs_register: (vfs: unknown, makeDefault: boolean) => void
}

let sqlite3: SQLiteAPI | null = null
let db: number | null = null

// Queue to serialize all database operations
type QueuedOperation = {
  fn: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const operationQueue: QueuedOperation[] = []
let processingPromise: Promise<void> | null = null

/**
 * Execute an operation serially in the queue to prevent concurrent access issues
 */
const queueOperation = <T>(fn: () => Promise<T>): Promise<T> => {
  return new Promise((resolve, reject) => {
    operationQueue.push({
      fn,
      resolve: resolve as (value: unknown) => void,
      reject: reject as (error: unknown) => void,
    })

    // Start processing if not already processing
    if (!processingPromise) {
      processingPromise = processQueue()
    }
  })
}

/**
 * Process queued operations one at a time
 */
const processQueue = async (): Promise<void> => {
  while (operationQueue.length > 0) {
    const operation = operationQueue.shift()!
    try {
      const result = await operation.fn()
      operation.resolve(result)
    } catch (error) {
      operation.reject(error)
    }
  }

  // Mark as no longer processing
  processingPromise = null
}

/**
 * Initialize the SQLite database with appropriate VFS based on path
 */
const initDatabase = async (filename: string): Promise<void> => {
  if (sqlite3 && db !== null) {
    // Already initialized
    return
  }

  // Load SQLite WASM module
  const module = await SQLiteESMFactory()
  const api = SQLite.Factory(module) as SQLiteAPI
  sqlite3 = api

  // For in-memory databases, skip VFS registration (no persistence needed)
  const isInMemory = filename === ':memory:'

  if (!isInMemory) {
    // Register OPFSCoopSyncVFS for OPFS persistence (synchronous, works with sync build)
    const vfs = await OPFSCoopSyncVFS.create(filename, module)
    api.vfs_register(vfs, true)
  }

  // Open database
  db = await sqlite3.open_v2(
    filename,
    SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
    isInMemory ? undefined : filename,
  )
}

/**
 * Execute SQL statement (internal - should be called through queueOperation)
 */
const execSqlInternal = async (
  sql: string,
  params: unknown[],
  returnMode: 'get' | 'all' | 'values' | 'run',
): Promise<WorkerResponse['result']> => {
  if (!sqlite3 || db === null) {
    throw new Error('Database not initialized')
  }

  const results: unknown[] = []

  try {
    // Use the statements iterator to prepare and execute
    statementLoop: for await (const stmt of sqlite3.statements(db, sql)) {
      // Bind parameters if provided
      if (params && params.length > 0) {
        sqlite3.bind_collection(stmt, params)
      }

      // Execute and collect results
      let stepResult
      while ((stepResult = await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        // row() makes proper copies of all data
        // Drizzle's sqlite-proxy expects arrays for all modes, not objects
        const rowValues = sqlite3.row(stmt)
        results.push(rowValues)

        // For 'get' mode, only return first row from first statement
        if (returnMode === 'get') {
          break statementLoop
        }
      }

      // stepResult should be SQLITE_DONE here
      if (stepResult !== SQLite.SQLITE_DONE && stepResult !== SQLite.SQLITE_ROW) {
        throw new Error(`Unexpected step result: ${stepResult}`)
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[Worker] Error executing SQL:`, errorMsg, '\nSQL:', sql.substring(0, 100))
    throw error
  }

  // Return results based on mode
  if (returnMode === 'run') {
    return { rows: [] }
  }
  if (returnMode === 'get') {
    return { rows: results.length > 0 ? results[0] : undefined }
  }
  return { rows: results }
}

/**
 * Execute SQL statement (queued to prevent concurrent access)
 */
const execSql = async (
  sql: string,
  params: unknown[],
  returnMode: 'get' | 'all' | 'values' | 'run',
): Promise<WorkerResponse['result']> => {
  return queueOperation(() => execSqlInternal(sql, params, returnMode))
}

/**
 * Close the database
 */
const closeDatabase = async (): Promise<void> => {
  if (sqlite3 && db !== null) {
    await sqlite3.close(db)
    db = null
    sqlite3 = null
    console.info('wa-sqlite worker: Database closed')
  }
}

/**
 * Handle incoming messages from the main thread
 */
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, method, params } = event.data
  const response: WorkerResponse = { id }

  try {
    switch (method) {
      case 'init':
        await initDatabase(params?.filename ?? ':memory:')
        response.result = { success: true }
        break

      case 'exec':
        response.result = await execSql(params?.sql ?? '', params?.params ?? [], params?.method ?? 'all')
        break

      case 'close':
        await closeDatabase()
        response.result = { success: true }
        break

      default:
        throw new Error(`Unknown method: ${method}`)
    }
  } catch (error) {
    // Suppress expected "no such table" errors during migrations
    const errorMsg = error instanceof Error ? error.message : String(error)
    // Only log in non-test environments to reduce test noise
    if (!errorMsg.includes('no such table: __drizzle_migrations')) {
      if (typeof process === 'undefined' || process.env.NODE_ENV !== 'test') {
        console.error('wa-sqlite worker error:', error)
      }
    }
    response.error = errorMsg
  }

  self.postMessage(response)
}

// Signal that worker is ready
self.postMessage({ id: -1, result: { ready: true } })
