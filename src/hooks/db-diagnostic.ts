/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getPowerSyncInstance } from '@/db/powersync/sync-state'

const classifyDbError = (error?: Error): string => {
  const cause = error?.cause instanceof Error ? error.cause : undefined
  const detail = error ? `${error.name} ${error.message} ${cause?.name ?? ''} ${cause?.message ?? ''}` : ''
  if (/NoModificationAllowedError|locked|busy/i.test(detail)) {
    return 'locked'
  }
  if (/quota|storage full/i.test(detail)) {
    return 'quota'
  }
  if (/schema|no such table|no such column/i.test(detail)) {
    return 'schema'
  }
  if (/open|OPFS|access handle|file system/i.test(detail)) {
    return 'open'
  }
  if (/worker|comlink/i.test(detail)) {
    return 'worker'
  }
  if (/wasm|WebAssembly/i.test(detail)) {
    return 'wasm'
  }
  if (/SQLITE|sqlite|SQL error/i.test(detail)) {
    return 'sqlite'
  }
  return 'other'
}

/** Emit only fixed diagnostic labels; browser errors can contain user data. */
export const reportDbDiagnostic = (
  phase: 'readiness' | 'query',
  outcome: 'pending' | 'ready' | 'rejected' | 'timed_out',
  error?: Error,
): void => {
  if (import.meta.env.VITE_DB_DIAGNOSTIC !== 'true') {
    return
  }

  const category = classifyDbError(error)
  const errorName =
    error &&
    /^(AbortError|InvalidStateError|NoModificationAllowedError|NotAllowedError|QuotaExceededError|SQLiteError|TypeError)$/.test(
      error.name,
    )
      ? error.name
      : 'other'
  console.warn(`[db-diagnostic] ${phase}=${outcome} category=${category} name=${errorName}`)
}

/** Observe readiness in the background without delaying the first query. */
export const observeDbReadiness = (
  getPowerSync: () => { waitForReady(): Promise<void> } | null = getPowerSyncInstance,
): void => {
  if (import.meta.env.VITE_DB_DIAGNOSTIC !== 'true') {
    return
  }

  const powerSync = getPowerSync()
  if (!powerSync) {
    return
  }

  reportDbDiagnostic('readiness', 'pending')
  void (async () => {
    try {
      await powerSync.waitForReady()
      reportDbDiagnostic('readiness', 'ready')
    } catch (error) {
      reportDbDiagnostic('readiness', 'rejected', error instanceof Error ? error : undefined)
    }
  })()
}
