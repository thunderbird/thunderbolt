/**
 * Web Worker for cr-sqlite database operations
 * This worker handles all SQLite operations with CRDT sync support
 */

// Suppress console output in test environments (worker has separate console from main thread)
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  console.error = () => {}
  console.warn = () => {}
  console.info = () => {}
}

import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm'

type WorkerRequest = {
  id: number
  method: 'init' | 'exec' | 'close' | 'getSiteId' | 'getChanges' | 'applyChanges'
  params?: {
    filename?: string
    sql?: string
    params?: unknown[]
    method?: 'get' | 'all' | 'values' | 'run'
    sinceVersion?: bigint
    changes?: CRSQLChange[]
  }
}

type WorkerResponse = {
  id: number
  result?: {
    rows?: unknown[] | unknown
    success?: boolean
    siteId?: string
    changes?: CRSQLChange[]
    dbVersion?: bigint
  }
  error?: string
}

/**
 * Represents a change record from crsql_changes
 */
export type CRSQLChange = {
  table: string
  pk: Uint8Array
  cid: string
  val: unknown
  col_version: bigint
  db_version: bigint
  site_id: Uint8Array
  cl: number
  seq: number
}

let db: DB | null = null

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
 * Initialize the SQLite database with cr-sqlite extension
 */
const initDatabase = async (filename: string): Promise<void> => {
  if (db !== null) {
    // Already initialized
    return
  }

  // Load cr-sqlite WASM module
  const sqlite3 = await initWasm()

  // For in-memory databases, pass undefined to skip IndexedDB persistence
  const isInMemory = filename === ':memory:'

  // Open database (cr-sqlite automatically uses IDBBatchAtomicVFS for persistence)
  db = await sqlite3.open(isInMemory ? undefined : filename)

  if (isInMemory) {
    console.warn('Using in-memory SQLite database (data will not persist)')
  } else {
    console.info(`cr-sqlite worker: Database opened with site_id: ${db.siteid}`)
  }
}

/**
 * Execute SQL statement (internal - should be called through queueOperation)
 */
const execSqlInternal = async (
  sql: string,
  params: unknown[],
  returnMode: 'get' | 'all' | 'values' | 'run',
): Promise<WorkerResponse['result']> => {
  if (!db) {
    throw new Error('Database not initialized')
  }

  try {
    if (returnMode === 'run') {
      await db.exec(sql, params as any)
      return { rows: [] }
    }

    // Execute and get results as arrays (matches Drizzle's expected format)
    const results = await db.execA(sql, params as any)

    if (returnMode === 'get') {
      return { rows: results.length > 0 ? results[0] : undefined }
    }

    return { rows: results }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[Worker] Error executing SQL:`, errorMsg, '\nSQL:', sql.substring(0, 100))
    throw error
  }
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
 * Get the site ID of the current database
 */
const getSiteId = (): string => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db.siteid
}

/**
 * Get changes from crsql_changes since the given version
 */
const getChangesInternal = async (sinceVersion: bigint): Promise<{ changes: CRSQLChange[]; dbVersion: bigint }> => {
  if (!db) {
    throw new Error('Database not initialized')
  }

  // Get the current db version
  const versionResult = await db.execA<[bigint]>('SELECT crsql_db_version()')
  const dbVersion = versionResult[0]?.[0] ?? 0n

  // Get all changes since the given version
  const changes = await db.execO<CRSQLChange>(
    `SELECT "table", "pk", "cid", "val", "col_version", "db_version", "site_id", "cl", "seq"
     FROM crsql_changes
     WHERE db_version > ?
     ORDER BY db_version, seq`,
    [sinceVersion],
  )

  return { changes, dbVersion }
}

/**
 * Get changes since a given version (queued)
 */
const getChanges = async (sinceVersion: bigint): Promise<{ changes: CRSQLChange[]; dbVersion: bigint }> => {
  return queueOperation(() => getChangesInternal(sinceVersion))
}

/**
 * Apply remote changes to the local database
 */
const applyChangesInternal = async (changes: CRSQLChange[]): Promise<void> => {
  if (!db) {
    throw new Error('Database not initialized')
  }

  if (changes.length === 0) {
    return
  }

  // Insert changes into crsql_changes - cr-sqlite will merge them
  const stmt = await db.prepare(
    `INSERT INTO crsql_changes ("table", "pk", "cid", "val", "col_version", "db_version", "site_id", "cl", "seq")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  try {
    for (const change of changes) {
      await stmt.run([
        change.table,
        change.pk,
        change.cid,
        change.val,
        change.col_version,
        change.db_version,
        change.site_id,
        change.cl,
        change.seq,
      ] as any)
    }
  } finally {
    await stmt.finalize(null)
  }
}

/**
 * Apply changes (queued)
 */
const applyChanges = async (changes: CRSQLChange[]): Promise<void> => {
  return queueOperation(() => applyChangesInternal(changes))
}

/**
 * Close the database
 */
const closeDatabase = async (): Promise<void> => {
  if (db !== null) {
    // Finalize cr-sqlite before closing
    await db.exec('SELECT crsql_finalize()')
    await db.close()
    db = null
    console.info('cr-sqlite worker: Database closed')
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

      case 'getSiteId':
        response.result = { siteId: getSiteId() }
        break

      case 'getChanges': {
        const { changes, dbVersion } = await getChanges(params?.sinceVersion ?? 0n)
        response.result = { changes, dbVersion }
        break
      }

      case 'applyChanges':
        await applyChanges(params?.changes ?? [])
        response.result = { success: true }
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
        console.error('cr-sqlite worker error:', error)
      }
    }
    response.error = errorMsg
  }

  self.postMessage(response)
}

// Signal that worker is ready
self.postMessage({ id: -1, result: { ready: true } })
