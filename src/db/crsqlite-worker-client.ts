/**
 * Client for communicating with the cr-sqlite web worker
 * Provides a promise-based API for database operations with CRDT sync support
 */

import type { CRSQLChange } from './crsqlite-worker'

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

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class CRSQLiteWorkerClient {
  private worker: Worker
  private requestId = 0
  private pendingRequests = new Map<number, PendingRequest>()
  private readyPromise: Promise<void>

  constructor(worker: Worker) {
    this.worker = worker

    // Wait for worker to be ready
    this.readyPromise = new Promise((resolve) => {
      const handleMessage = (event: MessageEvent<{ id: number; result?: { ready?: boolean } }>) => {
        if (event.data.id === -1 && event.data.result?.ready) {
          this.worker.removeEventListener('message', handleMessage)
          resolve()
        }
      }
      this.worker.addEventListener('message', handleMessage)
    })

    // Set up message handler for actual requests
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const { id, result, error } = event.data

      // Skip ready message
      if (id === -1) return

      const pending = this.pendingRequests.get(id)
      if (!pending) {
        console.warn('Received response for unknown request:', id)
        return
      }

      this.pendingRequests.delete(id)

      if (error) {
        pending.reject(new Error(error))
      } else {
        pending.resolve(result)
      }
    })

    this.worker.addEventListener('error', (event) => {
      console.error('Worker error:', event)
      // Reject all pending requests
      for (const pending of this.pendingRequests.values()) {
        pending.reject(new Error('Worker error'))
      }
      this.pendingRequests.clear()
    })
  }

  /**
   * Wait for the worker to be ready
   */
  async waitForReady(): Promise<void> {
    await this.readyPromise
  }

  /**
   * Send a request to the worker and wait for response
   */
  private async sendRequest(method: WorkerRequest['method'], params?: WorkerRequest['params']): Promise<unknown> {
    await this.waitForReady()

    const id = ++this.requestId
    const request: WorkerRequest = { id, method, params }

    return new Promise((resolve, reject) => {
      // Add 30 second timeout to prevent indefinite hangs
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(
          new Error(
            `Worker request timed out after 30s: ${method} ${params?.sql ? `SQL: ${params.sql.substring(0, 100)}...` : ''}`,
          ),
        )
      }, 30000)

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })

      this.worker.postMessage(request)
    })
  }

  /**
   * Initialize the database
   */
  async init(filename: string): Promise<void> {
    await this.sendRequest('init', { filename })
  }

  /**
   * Execute SQL statement
   */
  async exec(
    sql: string,
    params: unknown[],
    method: 'get' | 'all' | 'values' | 'run',
  ): Promise<WorkerResponse['result']> {
    return (await this.sendRequest('exec', { sql, params, method })) as WorkerResponse['result']
  }

  /**
   * Get the site ID of the current database
   */
  async getSiteId(): Promise<string> {
    const result = (await this.sendRequest('getSiteId')) as { siteId: string }
    return result.siteId
  }

  /**
   * Get changes since a given version
   */
  async getChanges(sinceVersion: bigint): Promise<{ changes: CRSQLChange[]; dbVersion: bigint }> {
    const result = (await this.sendRequest('getChanges', { sinceVersion })) as {
      changes: CRSQLChange[]
      dbVersion: bigint
    }
    return result
  }

  /**
   * Apply remote changes to the local database
   */
  async applyChanges(changes: CRSQLChange[]): Promise<void> {
    await this.sendRequest('applyChanges', { changes })
  }

  /**
   * Close the database
   */
  async close(): Promise<void> {
    await this.sendRequest('close')
  }

  /**
   * Terminate the worker
   */
  terminate(): void {
    this.worker.terminate()
    // Reject all pending requests
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('Worker terminated'))
    }
    this.pendingRequests.clear()
  }
}
