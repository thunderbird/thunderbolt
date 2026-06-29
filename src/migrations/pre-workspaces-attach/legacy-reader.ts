/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Read-only accessor for the pre-Workspaces SQLite database
 * (`thunderbolt-sync.db` or `thunderbolt.db`). All wa-sqlite work happens
 * inside a dedicated Worker — see `./legacy-reader.worker.ts` for the
 * rationale (CSP, OPFS sync-access-handle, Vite WASM URL handling).
 *
 * The main thread sees only a postMessage protocol: every call here resolves
 * to a single worker round-trip, keyed by an auto-incrementing request id.
 */

export type LegacyBackend = 'idb' | 'opfs'

export type LegacyReader = {
  /** True iff a table or view with this name exists in the legacy file. */
  hasTable(name: string): Promise<boolean>
  /** Column names in `PRAGMA table_info` order. Empty when the table is missing. */
  columnNames(name: string): Promise<string[]>
  /**
   * Returns every row of `name` as an array of values aligned positionally
   * with `columnNames(name)`. Empty when the table is missing. Binary columns
   * arrive as `Uint8Array`; everything else maps to its JS primitive.
   */
  selectAll(name: string): Promise<unknown[][]>
  /** Release the engine + terminate the worker. Idempotent. */
  close(): Promise<void>
}

type WorkerMethod = 'init' | 'hasTable' | 'columnNames' | 'selectAll' | 'close'
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/**
 * Open the legacy SQLite database for read-only access. The caller is
 * responsible for calling `close()` on the returned reader to terminate the
 * worker.
 */
export const openLegacyReader = async (filename: string, backend: LegacyBackend): Promise<LegacyReader> => {
  const worker = new Worker(new URL('./legacy-reader.worker.ts', import.meta.url), { type: 'module' })

  let nextId = 0
  const pending = new Map<number, Pending>()
  let closed = false

  const ready = new Promise<void>((resolve) => {
    const handleReady = (event: MessageEvent<{ id: number; result?: { ready?: boolean } }>) => {
      if (event.data.id === -1 && event.data.result?.ready) {
        worker.removeEventListener('message', handleReady)
        resolve()
      }
    }
    worker.addEventListener('message', handleReady)
  })

  worker.addEventListener('message', (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const { id, result, error } = event.data
    if (id === -1) {
      return // ready signal, handled above
    }
    const slot = pending.get(id)
    if (!slot) {
      return
    }
    pending.delete(id)
    if (error) {
      slot.reject(new Error(error))
    } else {
      slot.resolve(result)
    }
  })

  worker.addEventListener('error', (event) => {
    for (const slot of pending.values()) {
      slot.reject(new Error(`Legacy-reader worker error: ${event.message}`))
    }
    pending.clear()
  })

  const request = async <T>(method: WorkerMethod, params?: Record<string, unknown>): Promise<T> => {
    if (closed) {
      throw new Error('Legacy reader has been closed')
    }
    await ready
    const id = ++nextId
    return new Promise<T>((resolve, reject) => {
      // 30s ceiling matches `wa-sqlite-worker-client.ts`. Reading a thousand
      // rows from a local SQLite file is sub-second; anything past 30s means
      // the worker is wedged and we'd rather fail loudly than hang the boot.
      const timeoutId = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Legacy-reader request timed out after 30s: ${method}`))
      }, 30_000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutId)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timeoutId)
          reject(error)
        },
      })
      worker.postMessage({ id, method, params })
    })
  }

  // Open the engine. Failures here propagate to the caller — same as the
  // pre-worker reader's contract.
  await request<{ ready: true }>('init', { filename, backend })

  return {
    hasTable: (name) => request<boolean>('hasTable', { name }),
    columnNames: (name) => request<string[]>('columnNames', { name }),
    selectAll: (name) => request<unknown[][]>('selectAll', { name }),
    close: async () => {
      if (closed) {
        return
      }
      // Don't flip `closed` until AFTER the close request goes through —
      // `request()` checks the same flag and would refuse to dispatch,
      // leaving us with a worker that's never told to close. The close
      // itself is best-effort: the worker is being terminated either way,
      // so a failure here shouldn't bubble up to the migration caller
      // (where it would skip `setCompletionFlag` and cause a re-run).
      try {
        await request<{ closed: true }>('close')
      } catch {
        // Swallow — terminate() below releases the worker regardless.
      }
      closed = true
      worker.terminate()
      // Reject anything still in flight (timeouts will already have fired,
      // but be explicit for resolve-once semantics).
      for (const slot of pending.values()) {
        slot.reject(new Error('Legacy reader closed'))
      }
      pending.clear()
    },
  }
}
