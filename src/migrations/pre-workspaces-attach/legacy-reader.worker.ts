/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Read-only wa-sqlite engine for the pre-Workspaces SQLite database, running
 * in a dedicated Worker so that:
 *
 *   - WASM compile isn't blocked by the document CSP (`wasm-unsafe-eval`).
 *     Workers have their own CSP context derived from the script URL.
 *   - `OPFSCoopSyncVFS.createSyncAccessHandle()` is callable. The OPFS spec
 *     only exposes it inside Workers; on the main thread it throws
 *     `TypeError: ... is not a function`.
 *   - Vite's worker pipeline resolves `import.meta.url` correctly so each
 *     wa-sqlite factory's `new URL('./*.wasm', import.meta.url)` finds the
 *     WASM sibling. Static imports work cleanly here — no `@vite-ignore`
 *     dance, no main-thread bundling quirks.
 *
 * Matches PowerSync's own adapter pattern: wa-sqlite never runs on the main
 * thread.
 *
 * Protocol: one request → one response, keyed by `id`. Mirrors
 * `wa-sqlite-worker-client.ts` style so familiarity carries over.
 */

import * as SQLite from '@journeyapps/wa-sqlite'
import SQLiteAsyncFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs'
import SQLiteSyncFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs'
import { IDBBatchAtomicVFS } from '@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js'
import { OPFSCoopSyncVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js'

export type LegacyBackend = 'idb' | 'opfs'

type WorkerRequest =
  | { id: number; method: 'init'; params: { filename: string; backend: LegacyBackend } }
  | { id: number; method: 'hasTable'; params: { name: string } }
  | { id: number; method: 'columnNames'; params: { name: string } }
  | { id: number; method: 'selectAll'; params: { name: string } }
  | { id: number; method: 'close' }

type WorkerResponse = {
  id: number
  result?: unknown
  error?: string
}

const quoteId = (name: string): string => `"${name.replace(/"/g, '""')}"`
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`

type SqliteApi = ReturnType<typeof SQLite.Factory>

let sqlite3: SqliteApi | null = null
let dbHandle: number | null = null

const initEngine = async (filename: string, backend: LegacyBackend): Promise<void> => {
  if (sqlite3 && dbHandle !== null) {
    // Already initialised — duplicate init is a no-op.
    return
  }
  // IDBBatchAtomicVFS is async-only → Asyncify build. OPFSCoopSyncVFS is sync
  // and the sync build is smaller. Picking per backend mirrors PowerSync's
  // own VFS-to-factory choice.
  const factory = backend === 'idb' ? SQLiteAsyncFactory : SQLiteSyncFactory
  const module = await factory()
  sqlite3 = SQLite.Factory(module)
  const vfs =
    backend === 'idb'
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (IDBBatchAtomicVFS as any).create(filename, module)
      : await OPFSCoopSyncVFS.create(filename, module)
  // makeDefault=true so subsequent open_v2 uses this VFS. Safe because this
  // is a fresh engine with no prior state.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sqlite3.vfs_register(vfs as any, true)
  // Read-only open: legacy data must remain bit-identical for rollback. The
  // tmp scratch files OPFSCoopSyncVFS creates live under `.ahp-<random>` at
  // the OPFS root, not inside the legacy DB itself.
  dbHandle = await sqlite3.open_v2(filename, SQLite.SQLITE_OPEN_READONLY)
}

const runQuery = async <T>(sql: string, readRow: (stmt: number) => T): Promise<T[]> => {
  if (!sqlite3 || dbHandle === null) {
    throw new Error('Worker not initialised — call init first')
  }
  const rows: T[] = []
  for await (const stmt of sqlite3.statements(dbHandle, sql)) {
    while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
      rows.push(readRow(stmt))
    }
  }
  return rows
}

const hasTable = async (name: string): Promise<boolean> => {
  const sql = `SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ${quoteLiteral(name)} LIMIT 1`
  const rows = await runQuery(sql, () => 1)
  return rows.length > 0
}

const columnNames = async (name: string): Promise<string[]> => {
  if (!(await hasTable(name))) {
    return []
  }
  // PRAGMA table_info rows: [cid, name, type, notnull, dflt_value, pk]
  return runQuery(`PRAGMA table_info(${quoteId(name)})`, (stmt) => sqlite3!.column(stmt, 1) as string)
}

const selectAll = async (name: string): Promise<unknown[][]> => {
  if (!(await hasTable(name))) {
    return []
  }
  return runQuery(`SELECT * FROM ${quoteId(name)}`, (stmt) => {
    const colCount = sqlite3!.column_count(stmt)
    const row: unknown[] = new Array(colCount)
    for (let i = 0; i < colCount; i++) {
      row[i] = sqlite3!.column(stmt, i)
    }
    return row
  })
}

const closeEngine = async (): Promise<void> => {
  if (sqlite3 && dbHandle !== null) {
    await sqlite3.close(dbHandle)
    sqlite3 = null
    dbHandle = null
  }
}

// Serialize every request through a single chained promise. wa-sqlite is
// single-threaded per engine — concurrent `statements()` / `step()` calls
// against the same dbHandle deadlock. Even though postMessage delivers
// requests one at a time, our handler awaits inside each call, so without
// this chain a second `onmessage` invocation would interleave with the
// first one's awaits.
let queue: Promise<unknown> = Promise.resolve()
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn)
  queue = next.catch(() => undefined)
  return next
}

const handle = async (req: WorkerRequest): Promise<unknown> => {
  switch (req.method) {
    case 'init':
      await initEngine(req.params.filename, req.params.backend)
      return { ready: true }
    case 'hasTable':
      return hasTable(req.params.name)
    case 'columnNames':
      return columnNames(req.params.name)
    case 'selectAll':
      return selectAll(req.params.name)
    case 'close':
      await closeEngine()
      return { closed: true }
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  const response: WorkerResponse = { id: req.id }
  try {
    response.result = await enqueue(() => handle(req))
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
  }
  self.postMessage(response)
}

// Signal the main thread that the worker has loaded and is ready to receive
// requests. Matches the existing `wa-sqlite-worker.ts` ready-pattern.
self.postMessage({ id: -1, result: { ready: true } })
