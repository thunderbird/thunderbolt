import { keyStorage } from './key-storage'
import { KeyState, getKeyState } from './master-key'

export const SyncState = {
  DISABLED: 'DISABLED',
  ENABLED: 'ENABLED',
} as const

export type SyncState = (typeof SyncState)[keyof typeof SyncState]

export type EnableSyncResult = { status: 'ENABLED' } | { status: 'REQUIRES_KEY_SETUP' }

const SYNC_ENABLED_KEY = 'thunderbolt_sync_enabled'

let _onSyncEnabledCallbacks: Array<() => void> = []

/** Returns the current sync state. Synchronous. */
export const getSyncState = (): SyncState => {
  const stored = keyStorage.get(SYNC_ENABLED_KEY)
  return stored === 'true' ? SyncState.ENABLED : SyncState.DISABLED
}

/**
 * Attempt to enable sync.
 * If KEY_PRESENT: enables sync immediately, returns ENABLED.
 * If NO_KEY: returns REQUIRES_KEY_SETUP (UI must open Sync Setup modal).
 */
export const enableSync = (): EnableSyncResult => {
  const state = getKeyState()
  if (state === KeyState.NO_KEY) {
    return { status: 'REQUIRES_KEY_SETUP' }
  }
  keyStorage.set(SYNC_ENABLED_KEY, 'true')
  _onSyncEnabledCallbacks.forEach((cb) => cb())
  return { status: 'ENABLED' }
}

/** Disable sync. Does NOT delete the key. */
export const disableSync = (): void => {
  keyStorage.set(SYNC_ENABLED_KEY, 'false')
}

/** Register a callback to be invoked when sync transitions to ENABLED. */
export const onSyncEnabled = (callback: () => void): (() => void) => {
  _onSyncEnabledCallbacks.push(callback)
  return () => {
    _onSyncEnabledCallbacks = _onSyncEnabledCallbacks.filter((cb) => cb !== callback)
  }
}

/** Clear all callbacks (for testing). */
export const _clearCallbacks = (): void => {
  _onSyncEnabledCallbacks = []
}
